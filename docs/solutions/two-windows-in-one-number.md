# A plan's recency number carried two different facts

`SearchPlan.recencyDays` meant one thing to the code and another to the model.
The code used it as the oldest a proof page may be. The synthesizer instruction
told the model to set it to "the widest window the profile allows", which is a
statement about the *event*. Those are different questions, and one number
cannot answer both.

Everything below was measured against the live gateway and the live Exa agent on
2026-08-31, across three unrelated profiles.

## How it showed

Two profiles that share no vertical both answered 365.

| profile | sells | `recencyDays` |
|---|---|---|
| identity verification | to fintechs and age-gated platforms | 365 |
| recruiting | to managed service providers | 365 |

A find-companies run on the first returned ten companies whose proof pages had a
median age of **231 days**. Six of the ten were older than 90. One was a press
release about an acquisition completed 362 days earlier, describing an
integration hiring wave that had long since finished.

Nothing refused them, and nothing was broken. `staleRejectReason` compares the
page against `recencyDays`, and 362 is inside 365. The judge kept them because
`JUDGE_INSTRUCTIONS` says outright: "A row whose `evidenceDate` falls outside the
freshness window never reaches you, so every date you see is inside it." The
judge was told the dates were already fine, so it never looked.

## What did not fix it

Four hypotheses, each measured and each wrong. They are recorded because each one
is plausible enough to be tried again.

**A richer query.** The theory was that the agent needed a fuller brief than one
short sentence. Measured on two profiles at three companies each, a full
multi-clause research brief against the production query:

| cell | proof-page ages |
|---|---|
| identity, short query | 0, 6, 257 |
| identity, rich brief | 179, 115, 174 |
| recruiting, short query | 18, 19, 33 |
| recruiting, rich brief | 89, 28, 10 |

Richness made one profile decisively worse. The rule in
`exa-search-contract.md` that a longer query buys nothing on its own was
measured against `/search`; this extends it to the agent.

**Absolute dates instead of a relative phrase.** Rendering the window as
"from 2026-07-17 through 2026-08-31 inclusive" rather than "in the last 45 days"
looked like the winner, until the comparison was run at a fixed window size:
eleven of twelve companies landed inside the window either way. The earlier
30-of-30 result came from the window being 30 days rather than 365, not from how
it was written. The system prompt already tells the agent today's date.

**The field name.** Renaming `recencyDays` to `proofMaxAgeDays`, with the
instruction text otherwise identical, changed nothing: 30/30 against 30/60 on
one profile, 45/45 against 45/30 on another.

**The profile's own stated windows.** The identity profile names three different
windows in its signal paragraph — 120 days, 6 months, 12 months — so the obvious
theory was that the model picks one off the page. Rewriting the paragraph to a
single window, and again to no windows at all, moved nothing: 45/45/45 against
60/45/45 against 45/45.

## What fixed it

**Give the profile's window somewhere else to live.** `eventWindowDays` sits
beside `recencyDays` in `SearchPlanModelSchema`. Nothing reads it; the round
report records it. Its whole job is to absorb the number the profile states, so
`recencyDays` is free to answer the other question.

**Make both fields required.** They were `.nullish()`, which is optional as well
as nullable, so the model could skip the question and fall back to the largest
number in front of it. Changed to `.nullable()`, six draws through the real
synthesizer on the profile that failed worst went 45, 45, 45, 30, 45, 30. The
four draws before the change were 120, 60, 365, 45. Eighteen tests failed the
moment the fields became required, every one of them a fixture that had omitted
them — which is the same skip, in the test suite.

**Put the reasoning in the instruction, not a number.** The instruction now asks
how old a page may be and still show the situation is live, and explains why
that differs from the event window. Measured with two fields and no reasoning,
the proof window ranged 30 to 270 across three profiles. With the reasoning:
30, 30, 30, 30, 30, 45.

**Tell the agent the window the filter enforces.** `recencyDays` reached
`staleRejectReason` and stopped there, while the query still carried the
profile's event windows of up to twelve months. The agent hunted under the wider
rule and the filter killed what came back: one round returned eight companies
and lost five that way, all of them paid for. `agentQuery` now appends the
model's own number as a sentence. Filter refusals across a later three-round run
fell to three of thirteen.

## Where it stands

Three unrelated profiles, ten companies each, one clean pool:

| profile | found | median proof age | discarded | cost |
|---|---|---|---|---|
| identity verification | 10 of 10 | 13 days | 5 | $0.44 |
| recruiting | 10 of 10 | 18 days | 4 | $0.31 |
| software supply-chain security | 10 of 10 | 28 days | 1 | $0.30 |

The third profile is the one worth trusting, because it was written after every
fix and shares no vertical, no signal type and no buyer with the other two. It
states no time windows anywhere, and the synthesizer supplied its own — event
365, proof 45 — then found ten companies whose npm namespaces had been publicly
compromised, with zero filter and zero judge refusals.

The same profile before the fix returned **zero companies across three rounds**
for $0.27, because every round chose `exa-search`, and the company index holds
no events for a judge to keep.

## What is still true and unfixed

**Round one draws its window blind.** Feedback only reaches round two. A first
round that draws wide fills the list with what it finds, and the engine keeps the
first companies rather than the freshest. On one run this put four pages of 69,
89, 147 and 180 days into a list whose other six were under 20.

**Feedback is never persisted.** The `round` table stores the plan and the
rejects, not the feedback string, so what the model actually read on any given
round cannot be recovered after the fact.

**The round-to-round window feedback was removed, unmeasured.** It reported
"kept nothing" whether the agent found nothing or the judge refused everything —
those deserve opposite lessons and it gave them the same one — and on a search
round it had nothing to report at all, since the company index carries no pages.
Its effect on an agent round was never isolated from the angle also changing
each round, so it was cut rather than fixed. The two fields it fed,
`eventWindowDays` and `recencyDays`, are unaffected: they still travel from the
profile through the plan to `staleRejectReason` and `agentQuery`.

## The trap that cost the most time

A probe harness that hand-wrote the JSON schema measured **stabler** than
production, which goes through the AI SDK's `Output.object` with the Zod schema.
The harness reported 45, 45, 45 on a profile where production drew 120. Three
hypotheses were chased on the strength of harness numbers before the difference
was noticed.

When a probe measures a model's behaviour, call the repo's own function. Importing
`synthesize` from `src/core/synthesize.ts` under `bun` works and takes one line.
