The default should be a fixed provider cascade plus one ID-based selection pass. The adaptive loop must earn its complexity in Gate 2; until then, do not build it.

Use stable candidate IDs, not strings or positional indexes. Indexes break when candidates are deduplicated or reordered between rounds. The model returns IDs only; the system copies the observed title from the candidate record. Unknown IDs fail closed. This folds into Gate 2—no fifth experiment.

## Validity precondition

Before any gate, prove the experiment is addressing the right company:

- Resolve the canonical domain independently of the stored slug.
- `kraken-exchange` must produce “invalid target,” not “zero employees.”
- Evergreen’s unrelated people must fail company-identity matching.
- A BrightData timeout must be “provider unavailable,” never an empty roster.
- Apollo-only records count as leads, not returned people, until the obfuscated identity resolves to a full person.

Failure here invalidates the run. This is a data contract, not another experiment.

## Gate 1 — Does the stored profile preserve client intent?

| Item | Pre-registered design |
|---|---|
| Measurement | Candidate-level precision and recall against client labels, comparing the verbatim client brief with the stored ICP |
| Sample | 10 seller profiles × 20 real candidates = 200 candidates |
| Pass | Stored-ICP macro precision ≥95%, recall ≥85%, both within 5 points of the raw-brief condition; every profile precision ≥90% and recall ≥70%; zero unknown IDs |
| Cost | 20 OpenRouter selection calls, roughly $0.30–$0.70; no provider spend; 3–4 hours of client/analyst labeling |
| Stop | Any failed threshold stops all retrieval experiments. Repair onboarding/profile capture first. |

For each seller, use 10 client-confirmed buyers/champions and 10 hard negatives. At least half the positive set should have messy, noncanonical titles such as “Chief Architect” rather than “CTO.”

Run the same ID-only selector twice:

1. Against the verbatim client intake.
2. Against the stored ICP.

This distinguishes two failures:

- Raw brief passes, stored ICP fails: profile compression corrupted intent.
- Both fail: selection cannot operationalize the client’s intent.

Do not continue because “most profiles passed.” One catastrophic profile like the measured 74% versus 1% case is enough to make downstream aggregate accuracy meaningless.

## Gate 2 — Does an adaptive loop beat the strongest fixed cascade?

### Arms

The paired baseline must not be intentionally weak.

**A — Fixed cascade, one selection pass**

1. Clay partitioned by the eight measured seniority bands.
2. Apollo using seniority plus department—not exact titles.
3. Exa broad search plus up to two resolution searches based on Apollo’s observed titles.
4. BrightData for unresolved executive/C-suite gaps.
5. Union and deduplicate.
6. Select using stable candidate IDs.

**B — Adaptive challenger**

Start with exactly A’s candidate table, then allow at most two adaptive retrieval rounds. The synthesizer may choose filters or queries from observed organization vocabulary, but it may not manufacture output people or titles. Selection remains ID-only.

Run both adaptive rounds during the experiment even if a shadow judge says stop. Otherwise there is no counterfactual against which to evaluate stopping.

### Pre-registered design

| Item | Pre-registered design |
|---|---|
| Measurement | Additional unique, human-confirmed eligible buyers returned by B over A, per company, at fixed precision |
| Sample | 36 companies across at least 6 sellers: 12 under 50 employees, 12 with 100–499, 12 with 500+ |
| Pass | On the 24 companies with 100+ employees: ≥12 additional buyers total, ≥1 additional buyer at ≥6 companies, marginal precision ≥90%, paired-bootstrap 95% lower bound above zero, and overall precision no more than 2 points below A |
| Structural pass | Zero invented titles, unknown IDs, or output strings not copied from a selected candidate |
| Cost | Clay: 288 quota calls; Apollo: $0; Exa: at most 180 searches = $1.26; BrightData roughly $25–$75 depending returned rows; OpenRouter roughly $3, cap at $10; 6–10 hours blinded adjudication |
| Stop | If the primary threshold fails, drop the loop and do not run Gate 4. |

An eligible returned buyer must have:

- Full identity—not only Apollo’s obfuscated surname.
- A stable profile URL or provider record.
- A verbatim observed title.
- A current-company claim.
- A client-rubric buyer label from blinded adjudication.

Apollo’s new result changes its role: it is mandatory broad discovery, but its unresolved rows do not inflate the final-person count.

### Round-depth decision

- Keep one adaptive round only if the combined Gate 2 threshold passes.
- Keep round two only if round two alone adds at least 6 buyers across the 24 larger companies—0.25 per company—at ≥90% marginal precision.
- Otherwise cap the method at one adaptive round.

For companies under 50, default to no loop. Override that only if the small-company stratum independently achieves the same 0.5 additional buyers/company threshold.

### Ground-truth limitation

Do not report recall against “known seniors.” That denominator is contaminated.

Gate 2 measures marginal adjudicated yield from the pooled A+B candidate set. It can decide whether the loop adds useful people. It cannot establish absolute organizational recall, because nobody has an independent census of all buyers.

Report two diagnostics:

- Additional qualifying candidates available before model selection.
- Additional qualifying people actually selected.

If retrieval improves but selected output does not, the selector failed; the loop did not.

## Gate 3 — Can first-party evidence verify enough output to ship?

Plainly: overall verification yield measures the joint system of pipeline correctness **and whether companies publish named employees**. It is not a pure pipeline-accuracy metric.

Separate the two.

### Labels

- `CONFIRMED`: a company-domain page supports current employment and buying function.
- `CONTRADICTED`: first-party evidence directly conflicts with the claimed employer or function.
- `UNKNOWN`: no decisive first-party evidence. Silence is not an error.

Use current team pages or dated first-party material from the previous 12 months. Absence from a leadership page is not contradiction.

### Pre-registered design

| Item | Pre-registered design |
|---|---|
| Measurement | Overall confirmation yield, conditional accuracy when evidence exists, company publication coverage, and contradiction rate |
| Sample | 120 frozen pipeline outputs from 40 companies, exactly 3 per company, stratified by company size |
| Search budget | One general employee-publication search per company plus two domain-restricted searches per person |
| Pass | ≥84/120 outputs confirmed; conditional accuracy `confirmed / (confirmed + contradicted)` ≥98%; ≥30/40 companies yield at least one confirmed buyer |
| Cost | 280 Exa searches = $1.96; less than $1 OpenRouter extraction; 3–5 hours manual review |
| Stop | Fail any threshold: the methodology is not shippable as independently verified at scale. Do not increase the sample hoping silent sites become verbose. |

Report these separately:

1. **Publisher availability:** fraction of the 40 domains where the search channel finds any named employee.
2. **Pipeline agreement when decidable:** confirmed versus contradicted among records with evidence.
3. **Joint verification yield:** confirmed divided by all 120 outputs.

Interpretation:

- Low publisher availability plus few contradictions means the verification channel is sparse; it does not show that the pipeline is inaccurate.
- High contradiction means the pipeline is wrong.
- High conditional accuracy but less than 70% overall confirmation means only a verified subset is shippable. `UNKNOWN` results must remain explicitly unverified.

Harbor IT’s 1/10 result therefore does not imply nine bad selections. Combined with its website publishing no executives, it mainly predicts that universal first-party verification will fail.

Use mathematical futility stopping: after each batch of 40, stop if `confirmed so far + remaining records < 84`, or if 30 companies can no longer yield a confirmation.

## Gate 4 — Can the judge safely terminate productive retrieval?

Run this only if Gate 2 keeps a loop.

The judge must not answer “does this list look plausible?” It must predict the observable question:

> Will another permitted retrieval round produce at least one additional qualifying buyer?

That makes termination testable without pretending the candidate pool is complete.

### Pre-registered design

| Item | Pre-registered design |
|---|---|
| Measurement | Shadow judge’s false-stop rate against the forced next round’s actual marginal yield |
| Sample | 72 shadow decisions: after the fixed cascade and after round one for all 36 Gate 2 companies; embed 60 hard-negative controls—30 wrong-function, 30 stale |
| Pass | False-stop rate ≤5% on productive transitions; at least 90% of STOP decisions followed by a barren round; 0/60 hard negatives selected; zero unknown IDs |
| Minimum evidence | At least 20 productive transitions; otherwise the judge is not established |
| Cost | No new provider calls; 72 OpenRouter calls, roughly $1.50–$2.50 and capped at $5 |
| Stop | Any failed threshold, or fewer than 20 productive transitions: reject judge-controlled termination and use Gate 2’s fixed round cap. |

A false stop is exact: the judge said `STOP`, but the forced next round produced at least one blinded, human-confirmed eligible buyer.

The current 22% hard-negative FPR fails this gate before it starts. ID selection removes invention, but it does not repair semantic misclassification; the 60 controls test that separately.

Allow one judge repair using a development set, then one fresh locked evaluation. If it fails twice, abandon judge-controlled termination. Do not start a model tournament.

## Decision-impact ranking

1. **Gate 1 — Profile fidelity.** A wrong target makes every provider and judge result irrelevant.
2. **Gate 3 — Independent verification.** This decides whether “right people without errors” is an honest shipping claim. Current 1/10 evidence makes failure plausible.
3. **Gate 2 — Loop value.** This decides whether adaptive complexity adds buyers beyond the strongest fixed cascade.
4. **Gate 4 — Judge termination.** It matters only if Gate 2 already justified a loop.

Practical run order: Gate 1 → Gate 2 → Gate 3 → Gate 4. Gate 3 needs frozen output from the candidate methodology; Gate 4 is conditional.

## Explicitly do not run

- No provider “winner” contest.
- No more Apollo exact-title tests; the domain bug invalidated the old conclusion, and broad filters are the measured strength.
- No more cross-provider agreement studies among LinkedIn-derived sources.
- No more Harbor “known senior recall” claims.
- No capture–recapture estimate: the sources are correlated, violating its core assumption.
- No Findymail retrieval experiment; it added zero after BrightData and costs more.
- No more prompt-only attempts to prevent invented titles; enforce IDs structurally.
- No large first-party verification expansion after Gate 3 fails from publisher silence.
- No BrightData accuracy run while it is blocked or hanging; only rerun its health/identity canary.
- No further sub-50-company complementarity study unless the 12-company negative-control stratum unexpectedly passes.
- No Clay `has_more` investigation; partitioned senior bands already avoid the cap.
- No judge model bakeoff. One repaired judge, one locked test, then stop.

The repo’s current path still freezes one ICP-derived title plan and feeds it unchanged through retrieval ([people/index.ts](/Users/lahfir/Documents/Projects/Algominds/algo-backend/src/core/people/index.ts:51), [find-people.ts](/Users/lahfir/Documents/Projects/Algominds/algo-backend/src/workflows/find-people.ts:275)). The experiments should not modify that engine until Gate 2 demonstrates that adaptation is worth adding.
