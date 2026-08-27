# Why Apollo and BrightData's rates in `RATES` are placeholders

`RATES` in `src/core/rates.ts` prices Apollo credits at `0.01` and BrightData records at
`0.0025`. Neither number is a verified account price.

## The problem

`CostLedger.metered()` needs a dollar-per-unit rate for every non-model vendor call, sourced
from one configuration object. Apollo and BrightData are both metered, so both need an entry.

## Apollo credits

Apollo's public pricing documents credit *counts* per operation (people search is free,
`bulk_match` costs 1-9 credits per person), but never a dollar value for one credit. That
number lives behind a sales-negotiated plan tier, not anything publicly readable. `0.01` is a
round placeholder ceiling, not a price anyone confirmed.

## BrightData records

BrightData publishes one price: about $0.0025 per record in its marketplace dataset, at the
100,000-record tier. The dataset trigger this codebase actually calls is the live-trigger API,
whose pricing BrightData's own docs mark as undocumented. `0.0025` is the closest published
number, not a confirmed live-trigger price.

## Upgrade path

Replace both constants with the real per-unit price from each vendor's account once available.
Nothing else changes — `rateFor` and `CostLedger.metered()` read whatever `RATES` holds, so a
price correction is a one-line edit in this one file.

## Verification

`test/rates.spec.ts` asserts `rateFor` reads these two entries from `RATES` directly, so a
price edit here is exercised by the existing test without any other change.
