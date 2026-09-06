1. **4—change `judgeBatchSize` from 8 to 4 first.** The log proves deadline exhaustion, not whether input processing, reasoning, generation or gateway waiting dominates. Descriptions are capped at 600 characters, but homepage evidence adds up to 4,000 per row; halving rows reduces both input and required judgments. Doubling the global timeout expands the failure budget everywhere.

   Screen **the saved Form3 judge inputs**, unchanged, at batch size 4 with confirmed cache misses and a **$2 ceiling**; no search or people calls needed. Require every slice to finish within 90 seconds without retry, retained positive controls, rejected negative controls, and no new group duplicates. Smaller slices increase concurrent calls and shrink `sameOrganizationAs` visibility—this is not a semantics-free config change.

2. **No—not another whole-step retry after two model attempts.** Override retries to **zero only for `round_*-judge`**, retaining the existing one internal retry for this screen. Do not change shared `paidCall` or turn timeout into the permissive “unproven” fallback.

   `judge()` uses `Promise.all`: one failing slice currently causes the durable retry to rerun successful slices too. Also, timeout costs are not recorded by `attemptStructured`; reconcile gateway billing before treating **$45.52 as complete spend**. The retry arithmetic supports the earlier hang hypothesis but does not fully explain 1,162 seconds.

3. **Yes—inspect now; change fan-out later.** That is substantial retrieval waste, but not proof of excessive **agent** fan-out. The search route also searches multiple plans; filtering includes missing company records and bounds/window failures. Group those 722 rejects by reason and inspect actual requests, route, unique domains and stage timings at zero cost. They were filtered **before judging**, so they did not directly enlarge the judge prompt. Cutting retrieval blindly could reduce fulfilment.

4. **Timeout first.** It is a demonstrated reliability failure; grounding adds output and could exacerbate it. After zero-cost retry tests and billing reconciliation, allocate the remaining budget:

   - **Up to $2:** saved-input timeout screen above.
   - **Up to $3:** corrected grounding replay plus Ondato/Form3, count 5 each, only if timeout screening passes.
   - **Up to $6:** seven-profile confirmation, count 5 each, only if both screens pass.
   - **$3.50 reserve:** unknown charges or one targeted diagnostic—not another speculative arm.

   These are allocation ceilings, not guaranteed invoices; the existing ledger cannot enforce a hard cap on unreported timeout charges.


