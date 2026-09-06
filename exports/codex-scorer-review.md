**Do not spend yet. Step 0 is incomplete.** I read `3bcca47`, the baseline checkout, both completed probe diffs, and the phase-2 plan. Four local scorer probes reproduced incorrect results; no vendor calls were made.

1. **Fix these before spending.**

   - **The proposed loop destroys its evidence.** Each invocation drops/recreates `eval_p2base`; each writes the same manifest filename. Your wrapper totals spend from those databases, so deleted runs disappear from its budget too. Also, `MIN_TRIALS=2` rejects `--trials 1`. [arm-db.ts](/Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-eval-chain/eval/arm-db.ts:50)
   - **Wrong-employer rows can pass.** Acceptance looks up LinkedIn URL without checking the key’s employer. I reproduced a buyer labelled at A scoring **1.0 at B**. A separately labelled `reject:wrong-employer` row also leaves gates green. `peopleVerdict` is calculated but never gates the composite; company completion is never checked. Enforce employer-bound acceptance, prohibited-person failures, and valid outcomes for both runs. [engine-score.ts](/Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-eval-chain/eval/engine-score.ts:56)
   - **Missing accounting passes.** `totalSeconds=null` scored **1.0**. Require complete, finite, nonnegative accounting. Freeze explicit count-five **full-chain** ceilings; currently these are scaled company-only bars.
   - **Empty company output breaks the trial.** It sends `domains: []`, which the API rejects. Because spend is banked only after the entire chain returns, that paid failure is unaccounted. Preserve IDs/cost after each stage; empty output must produce a recorded zero, with no people call. [full-chain.ts](/Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-eval-chain/eval/full-chain.ts:140)
   - **Identity/count handling is unfinished.** A lone `same-as:` alias of an accepted company earns zero; that biases dedupe comparisons. Resolve canonical acceptance before counting. Overdelivery also produced **engine_score=2**: enforce the requested-count contract and bounded scores.
   - **Rescoring is not preserved.** People are read through mutable company membership; output contains aggregates, not frozen scoring inputs. Save each trial’s rows/evidence and label versions for offline rescoring. Missing/skipped profiles must mark the rating **incomplete**—the current mean omits them. The manifest also still declares the old cost-per-stored-company winner rule.

   **What is fine:** the composite’s basic arithmetic, requested-company denominator, duplicate-person penalty, separate quality diagnostics, sanitized input, and same-arm company→people sequence.

2. **Keep seven profiles × one trial × five companies as a screening baseline.**

   After fixing the runner, use **one invocation without `--profile`**; it already serializes trials. Preserve the original seed documents for baseline comparison, and blind labelling to arm and production verdict.

   Enforce a separate **$5 baseline envelope** inside the shared **$18 phase cap**, counting failures and reserving remaining spend before paid work. Checking an already-spent total between runs cannot guarantee either ceiling. If seven profiles cannot finish within $5, report an incomplete baseline; do not average the survivors into a rating.

3. **Use targeted probes, then seven-profile combined confirmation. One draw is screening evidence, not proof of improvement.**

   | Probe | Required scope | “Won” for inclusion in confirmation |
   |---|---|---|
   | **Words** | **2 profiles: Ondato, Form3**, with fixed-roster replay first | Correct the documented founder/director mistakes; lose no accepted company coverage or independently accepted buyers on replay. Live screen: no gate failure, no lower accepted-company count, buyer coverage, or buyer precision; at least one intended error corrected. |
   | **Speed** | **2 contrasting profiles: Mstone, Form3** | Same quality safeguards and hard-negative decisions; **≥20% lower full-chain seconds on both**, with cost no higher. This is a predeclared practical screening threshold, not statistical significance. |
   | **Dedupe** | **0 paid profiles initially** | Replay the captured cross-slice/cross-round duplicates: one qualifying representative per buying organisation, no distinct organisation lost, no rejected representative replacing an accepted one. A count-five live run that encounters no duplicate proves nothing about this fix. |

   **Final promotion:** combine only screened winners, then run **all seven profiles once**. Require complete labels/accounting, no hard-gate failures, and no unexplained decrease in accepted-company count, buyer coverage, or buyer precision. Quality changes must demonstrate their intended correction; speed may win with unchanged quality. Any regression is **inconclusive pending replay/repetition**, not something the mean can excuse. No confirmation budget means no promotion.

4. **Revert the malformed Form3 replacement and the premature live rollout.**

   The actual text now says **“roughly 501 employees up through 501 to 10,000”** and calls **“501 to 10,000 flagship…”** the dead zone. That corrupts the acceptance contract. Rewrite that paragraph coherently around the frozen 501–10,000 requirement. [form3.json](/Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-words/eval/arm-seed/form3.json:12)

   Keep the rubric candidates isolated until tested; restore the previous live documents meanwhile. Local baseline seeding uses repository JSON, so those live edits do not contaminate it.

   **Keep the deletion arm and scorer architecture.** The inspected deletions are justified; the scorer needs repairs, not replacement. I did not independently rerun the deletion gate or verify live documents.


