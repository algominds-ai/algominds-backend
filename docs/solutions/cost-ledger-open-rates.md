# What we do not know about vendor costs

Three vendor dollar figures and one response shape used by the cost ledger are unconfirmed.
This file is where whoever resolves one should look first, and where a probe's findings should
land once one is captured.

## Findymail credits: `RATES.findymail.credits` = `0.01`

Findymail is the one vendor `CostLedger.metered()` still prices in v1 — every other call
either returns its own dollar figure inline (Exa `/search`, the AI Gateway) or costs nothing
(Apollo People Search) or is cut from v1 entirely (Apollo enrichment, BrightData). No public
Findymail price list was found; `0.01` is a round placeholder, not a confirmed rate.

**Status:** unknown pending a published rate card or an account lookup.

## Apollo credits (not currently priced — enrichment is cut from v1)

Apollo's public API pricing documents credit *counts* per operation (people search is free,
`bulk_match` costs 1-9 credits per person), but never publishes a dollar value for one credit.
Apollo states that figure is visible only inside the account dashboard, under Settings >
Billing — it depends on the specific plan tier, not a public rate card.

Apollo enrichment (the only Apollo call that spends a credit) is cut from v1, so `RATES` has no
Apollo entry today. This stays documented in case enrichment returns.

**Status:** unknown pending an account lookup, if this path is reinstated.

## BrightData records (not currently priced — out of v1)

BrightData publishes one price: about $0.0025 per record in its marketplace dataset, at the
100,000-record tier. The dataset trigger this codebase would call is the live-trigger API,
whose pricing BrightData's own documentation does not state anywhere reachable.

BrightData is out of v1 — it can only fetch a profile by URL, not discover a person, so nothing
in v1 calls it. This stays documented in case it returns as a fetch step downstream of
discovery.

**Status:** unknown pending BrightData publishing a live-trigger price, if this vendor returns.

## AI Gateway spend-limit response body: `isSpendLimitExceeded` in `src/core/cost.ts`

An AI Gateway spend limit and an ordinary rate limit both return HTTP 429. A retry policy needs
to treat them oppositely: a spend-limit block should not be retried (the budget is gone until
the window resets), while an ordinary rate limit should back off and retry.

Cloudflare's own spend-limits documentation states that a blocked request "returns a 429 Too
Many Requests response" and describes the blocking behavior, but does not publish a response
body shape, an error code, or any field to key a classifier off. Checked directly against
Cloudflare's documentation: no such shape exists in the published docs as of this writing.

`isSpendLimitExceeded` currently parses the body against the `{ error: { message: string } }`
envelope other AI Gateway error paths use, and checks that message for "spend limit" or
"budget". A body that doesn't match this envelope, or a message without either phrase, is
treated as an ordinary (retryable) error. It is a heuristic, not a confirmed contract.

**Status:** unknown pending a captured real blocked response. A smoke test run against a
gateway with a spend limit configured is expected to surface the real shape, which should
replace this heuristic with an exact field check.

## Verification

`test/rates.spec.ts` asserts `RATES` holds the Findymail entry directly. `test/cost.spec.ts`
asserts `isSpendLimitExceeded` classifies a spend-limit message as non-retryable and an
ordinary rate-limit message as retryable. Both suites keep passing unchanged once a real number
replaces a placeholder.
