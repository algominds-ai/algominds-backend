### 1. Rating and noise

**No—not as an unqualified quality rating.** **4.75 reproduces the export, but I found a scorer bug.**

Companies are canonicalized to organisation groups; buyer employers are not. Using frozen key `cca2fb6` and the saved final manifest, Mstone’s two CommSec buyers are both labelled **accept**, yet disappear because `commsec.com.au` is compared against `commbank.com.au`. Correcting that join gives **16/16 buyers, four covered companies, score 0.80**, not 14/16, three and 0.525. That correction alone makes the aggregate **5.14**, with other rows unchanged. [Scorer](</Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-base/eval/engine-score.ts>)

Do not publish a corrected improvement until **both experiments are rescored with identical keys and scorer**.

For repeatability, I would budget **±2 rating points**—a judgment allowance, **not a statistical confidence interval**. One profile flipping 0→1 moves the rating 1.43 points; Aris and Form3 each flipped the opposite way. **+0.46 is not convincing improvement evidence.**

### 2. Promoted changes

**A: No, not yet as an unrestricted default.** Two approximately 270-second appearances support a useful speed improvement, but different rosters prevent attributing the entire 635→271 reduction to concurrency. Five companies × five verifications permits 25 simultaneous verification pipelines; concurrency is not account-wide rate control.

**Cheapest falsifier:** inspect existing request timestamps, 429s and retries for evidence that increased fan-out creates throttling or failed verifications; no paid run required.

**B: Yes, provisionally.** Supplying an already-available fact needed by the existing rubric is a justified repair, not a new eligibility heuristic. The evidence supports merging the input correction, **not claiming a general precision lift**.

**Cheapest future falsifier:** selector-only paired replay on an identical roster containing the disallowed 65-person-company founder and an allowed finance owner; reject the claimed benefit if accepted buyers disappear or the forbidden founder remains.

### 3. Undecidable output

**Yes—fail the gate; do not remove it from the denominator.** An undecidable delivered company is unproven fulfilment, and excluding difficult outputs would reward the engine for producing things the evaluator cannot assess. Mark the run **not fully adjudicated**, retain its raw metrics, and distinguish uncertainty from confirmed incorrectness.

### 4. Tomorrow’s ceiling and first defects

**7.0/10—as an optimistic planning estimate, not a demonstrated ceiling.** A stochastic build has no defensible empirical upper bound from these runs.

The first three engine defects I would target:

1. **Semantic eligibility contradicts available company evidence.** Replay SteadyPay and the rejected Form3 verticals alongside legitimate near-neighbours under frozen requirements; require rejection of the wrong business models without sacrificing accepted output—no domain blacklist.
2. **Missing or incomplete judge output can still pass non-strict record requirements.** A zero-vendor replay with absent, duplicated and partial verdicts must leave affected rows unqualified, while preserving valid explicit verdicts.
3. **Person dedupe treats matching name/title/company as identity even across different LinkedIn URLs.** Replay two distinct same-name colleagues plus a genuine alias pair; preserve the former and collapse only the evidenced duplicate. [Identity code](</Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-final/src/core/people/person-identity.ts>)

Do not prescribe another retrieval provider until an uncovered company’s failure is localized.

### 5. What I refuse to sign

**Yes:**

- **“Mstone had two wrong buyers.”** The frozen labels say otherwise; the scorer loses them.
- **“Phase two proved improvement.”** Ungated quality barely moved, company yield fell, and previously perfect profiles failed.
- **“The final run confirmed both changes causally.”** It demonstrated combined behaviour on another draw.
- **“604 tests establish readiness or completeness.”** They establish neither.
- **“Labeller-ruled means independent ground truth.”** That requires evidence and adjudication controls, not a title.

**Signable conclusion:** two plausible repairs, unresolved company-qualification failures, substantial variability, and a material evaluation bug; spending stopped correctly at **$37.82**. No further paid runs are needed to expose or correct the scoring defect.


