1. Gate 1

It catches this only if the hard case includes client-labeled growth/onboarding positives and compliance negatives. Both selectors returning compliance people would then fail precision; raw-versus-stored agreement alone is not the pass condition.

Do not add Gate 0. It would measure whether a model can guess an unstated buyer, not whether the guess is correct. Treat “growth side, not compliance side” as part of the client-intent fixture/rubric. Otherwise neither condition represents the actual intent.

2. Contaminated thresholds

Re-derive these Gate 2 numbers:

- `≥12 additional buyers across 24`
- `≥1 additional buyer at ≥6 companies`
- Round-two `≥6 across 24`
- The `0.5/company` small-company override and the size-based no-loop default

Derive them from a separate development sample’s blinded, human-adjudicated A-versus-B buyer delta using an explicit client buyer rubric—never source agreement or regex matches—then freeze them before the 36-company evaluation.

Keep the independently chosen quality/safety bars: `≥90%` marginal precision, bootstrap lower bound above zero, ≤2-point overall precision loss, and structural zero-error rules. Their measurements must use clean labels. Gate 1, Gate 3, and Gate 4 thresholds were not derived from the listed regex figures, though any regex-created labels or controls must be replaced.

3. Reasons

Yes, add a closed-set basis label in the same selection call:

```json
{"id":"candidate_123","basis":"explicit_persona_match"}
{"id":"candidate_456","basis":"inferred_workflow_owner"}
```

No free text and no separate explanation call—the latter merely produces post-hoc rationalization. Log `basis` for diagnosis only; never parse it to decide eligibility, ranking, or returned titles.