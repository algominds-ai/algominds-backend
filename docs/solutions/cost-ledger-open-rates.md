# The two unresolved dollar rates in the cost ledger

`src/core/rates.ts` prices Apollo credits and BrightData records, but neither number is a
confirmed account price. This file is where whoever resolves one should look first.

## Apollo credits: `RATES.apollo.credits` = `0.01`

Apollo's public API pricing documents credit *counts* per operation (people search is free,
`bulk_match` costs 1-9 credits per person), but never publishes a dollar value for one credit.
Apollo states that figure is visible only inside the account dashboard, under Settings >
Billing — it depends on the specific plan tier, not a public rate card.

**Status:** unknown pending an account lookup. Someone with dashboard access needs to read the
real per-credit price and replace `0.01` with it.

## BrightData records: `RATES.brightdata.records` = `0.0025`

BrightData publishes one price: about $0.0025 per record in its marketplace dataset, at the
100,000-record tier. The dataset trigger this codebase actually calls is the live-trigger API,
whose pricing BrightData's own documentation does not state anywhere reachable.

**Status:** unknown pending BrightData publishing (or a support request surfacing) a
live-trigger price. `0.0025` is the closest published number, not a confirmed one.

## Why the placeholders stay in the meantime

Each number is one line in one file (`RATES`), so correcting either is a small, isolated edit
with no ripple effect through `CostLedger` or its callers.

## Verification

`test/rates.spec.ts` asserts `RATES` holds these two entries directly, so a price edit here is
exercised by the existing test without any other change.
