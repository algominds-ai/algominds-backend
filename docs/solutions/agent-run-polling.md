# Polling an Exa agent run

An agent run is started with one paid call and then polled until it
completes. Two decisions in that loop are not obvious from the code.

## A retryable error ends the poll, not the caller's step

`pollPersonEmail` in `src/core/providers/exa/agent-email.ts` polls inside a
single `enrich-batch-N` workflow step, up to 24 attempts, 5 seconds apart,
from `enrich.exaAgentMaxPollAttempts`. That setting is the enrichment
provider's own: it read the company agent's budget until raising that budget
for constrained company discovery silently took email enrichment from two
minutes to five.

If a poll raised a `RetryableProviderError` and let it escape, the whole
batch step would fail. Cloudflare then retries that step from the start,
which re-runs `enrich()` for every subject in the batch. Each subject that
reaches the agent-email provider again pays for a brand new `startAgentRun`,
while the original run keeps working, and billing, on Exa's side. With a
batch size of 5 and a retry limit of 2, one transient 429 could pay for ten
extra agent runs.

So a retryable error ends that single poll and the loop continues to the next
attempt. The run is already paid for; the only thing worth protecting is not
paying for it twice.

A 429 on the *start* call still throws. Nothing has been paid at that point,
so a retry there is correct and cheap.

## A non-retryable error is swallowed by the waterfall anyway

`exaAgentEmailProvider` sits last in the email waterfall. `waterfall()`
rethrows a `RetryableProviderError` and treats every other throw as a miss.
So a `NonRetryableError` from a bad request or an unexpected vendor shape
reaches production as "no email found", with no signal that the integration
itself is broken.

That is the waterfall's documented design, not a property of this provider.
It is recorded here because it means vendor schema drift on this provider
fails silently, and a future change may want a louder signal.

## Step names must be unique per company

`agentPersonSearch` in `src/workflows/find-people-agent.ts` is called once
per company inside one `people-batch-N` step. Cloudflare caches a step result
by name, so two companies sharing a nested step name would make the second
company receive the first company's agent run. Wrong people, no error.

The name carries the company's own domain, and the company is passed to the
search call rather than inferred. It used to be inferred: a counter was
incremented on each call and used to index the batch, which was correct only
while every caller reached the search in array order and never awaited before
it. The first await added upstream would have given one company another
company's name, and so another company's cached agent run. The counter is
gone.

Every paid call sits in its own step for a related reason. The poll loop
sleeps, a sleep replays `run()` from the start, and a paid call outside a step
would be paid again on every wake.
