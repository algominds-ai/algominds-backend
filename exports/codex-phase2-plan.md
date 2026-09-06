**Braintrust can report a defensible 0–10 rating. It cannot supply the definition of “correct.” Your current harness cannot yet support that rating, and the proposed matrix does not reliably fit $20.**

Reviewed `894532f`, the ledger, prior reviews, exports, and requested source. Read-only; no discovery spend. Braintrust MCP tools are not exposed in this session, so I checked current documentation—not your live experiment summaries.

## A. Five across many profiles beats twenty across three—for regression breadth

**Yes, but use the seven existing profiles first.** New onboarding is not the bottleneck.

Five exposes cross-profile mistakes cheaply, but one miss moves fulfilment by 20 points; it barely exercises later rounds, candidate exhaustion, cross-round duplication, or people-budget starvation. It also pays fixed synthesis overhead more often.

Your baseline + three arms + confirmation across thirteen profiles means **65 company runs: $16.25–26 company-only**, before onboarding, people, labelling, failures, or retries.

Allocate the $20 as spending envelopes, not promised run counts:

- $1: label calibration and adjudication.
- $5: seven-profile full-chain baseline.
- $5: targeted probes, including repetitions.
- $6: combined full-chain confirmation.
- $3: contingency; not another arm.

If the baseline exhausts its envelope, shrink experimentation—not confirmation or truth standards.

For fulfilment, log accepted distinct companies / **5**. For campaign depth, make successive five-company requests on two contrasting profiles with cumulative exclusions; the current fresh-organization-per-trial harness does not test this. Replay archived larger runs for cap/dedupe mechanics, but **do not call replay proof of live scale**.

Refusal sampling measures **false rejection among sampled retrieved candidates**, not market recall. Include filter rejects and unjudged candidates; judge-refusal logs alone miss both, and lack the original evidence needed for independent adjudication.

## B. The score and Braintrust shape

Your company formula double-penalizes precision: `accepted/requested` already discounts wrong output.

For each full-chain five-company run, define:

```text
A = distinct accepted companies delivered
B = those accepted companies with ≥1 accepted current buyer
T = distinct accepted buyers delivered at accepted companies
P = all delivered buyer rows, including wrong rows and duplicates

company_yield   = A / 5
buyer_precision = T / P                         (0 when P = 0)
buyer_coverage  = B / 5
engine_quality  = buyer_coverage × buyer_precision
engine_score    = gates_pass × engine_quality
rating          = 10 × mean_profile(mean_trial(engine_score))
```

Log company precision, accepted buyers, accepted output/dollar, and accepted output/minute separately. **Do not average good company discovery with bad people discovery and call the result success.**

Gates:

- Every delivered output adjudicated; unknown earns nothing and blocks promotion.
- No prohibited companies, duplicate buying organisations, wrong employers, or unsupported required evidence.
- Terminal outcome and complete, finite cost/time accounting; missing timestamps cannot pass.
- Frozen per-profile dollar/time ceilings at count five, plus the shared $20 budget.

Keep raw quality alongside gated scores so a latency failure does not erase the diagnosis. Missing profiles make a rating **incomplete**, not an invitation to average only successful rows.

Before spending, repair these existing measurement defects:

- [`eval/run.ts`](/Users/lahfir/Documents/Projects/Algominds/algo-backend/eval/run.ts:51) rejects `--trials 1`, defaults to three companies, scales time bars automatically, and resets its budget each invocation.
- [`headline.ts`](/Users/lahfir/Documents/Projects/Algominds/algo-backend/eval/headline.ts:87) calls name/domain presence “record bounds,” allows unknown labels through gates, and omits fulfilment.
- [`people-run.ts`](/Users/lahfir/Documents/Projects/Algominds/algo-backend/eval/people-run.ts:65) reads mutable company-linked people rather than immutable run output and does not publish a Braintrust experiment.
- The Braintrust input contains the entire seeded trial, **including its API key and random IDs**; remove credentials and use a stable scenario comparison key.

Use **versioned datasets, custom arithmetic scorers, explicit baseline comparisons, annotation queues, and summaries drilled down to regressions**. Pin profile, evidence, key, grader and model versions; rescore saved outputs after adjudication without rerunning vendors. Braintrust otherwise matches on input, so random trial IDs undermine comparisons. Do not use its generic “all scores average” as your engine rating. [Comparison documentation](https://www.braintrust.dev/docs/evaluate/compare-experiments)

An LLM evaluator can replace the **labelling agent’s execution**, not independent truth: same evidence packet, frozen written rulings, blinded to arm and production verdict, calibrated against owner-adjudicated positives, negatives and unknowns. Review disagreements and sampled confident accepts. A second model is not automatically independent. [Scorer validation](https://www.braintrust.dev/docs/evaluate/best-practices)

Defer online LLM scoring, grader ensembles, and elaborate trace infrastructure. Cheap online invariants can follow once the offline scorer is trustworthy.

**Scope warning:** this composite certifies “at least one buyer per company,” not finding every buyer; preserve known-buyer recovery as a separate check if completeness matters.

## C. Arms, ruthlessly ordered

| Priority | Decision | Promotion evidence |
|---|---|---|
| 0 | **Repair and replay the evaluator.** | Recover tonight’s accepted counts; empty output, missing labels, malformed verdicts and duplicates cannot pass. |
| 1 | **(a) Buyer/profile wording.** | On fixed rosters, remove Ondato’s false-founder picks without losing accepted coverage; resolve Form3’s contradictory acceptance contract before scoring it. |
| 2 | **(e) Short judge output.** | Same accepted yield and hard-negative handling, with consistently lower latency/cost across repeated five-company pairs on two profiles. |
| 3 | **(c) Identity dedupe, replay first.** | Collapse the captured brand duplicate across slices/rounds while retaining genuinely distinct buying organisations; live probe only if needed. |
| Defer | **(b) Coverage scheduling/carry.** | At count five, all five companies already start together; the current company cap is **100**, not twenty, so this budget barely exercises the proposed benefit. |
| Drop as stated | **(d) Stop on exhaustion.** | Already implemented; removing the three-round ceiling is a different, potentially expensive continuation experiment. |
| No paid arm | **(f) Truly dead-code removal.** | Caller search, focused checks and bundle verification; generated-output changes belong in the measured speed arm. |

Do not demand “mean rises and no profile falls” from one noisy draw. A speed arm should win with **unchanged quality**, and one lost result needs investigation and repetition—not automatic rejection or dismissal.

Parallelize bounded implementation/replay work; serialize paid measurements. Freeze the measurement checkout and inputs. Combine only demonstrated winners, then confirm the combination.

## D. Where search-route seconds go

The ledger’s stage measurements precede the final merge:

| Stage | Evidence |
|---|---|
| Synthesize | **15–34 seconds per round** |
| Exa search | **0.6–0.9 seconds per call** |
| Prove | About **1 second in that measured batch**; zero paid proving for record-only profiles |
| Homepage | Fetched before judging, but **not timed** |
| Judge | **11–52 seconds per round** in that baseline |
| Decide | Local code; no separately measured duration |

The historical “models consume ~95%” finding is useful, but not a measured breakdown of today’s homepage-enabled build. [`timedDeps`](/Users/lahfir/Documents/Projects/Algominds/algo-backend/src/workflows/find-companies-agent.ts:313) omits homepage calls; add that measurement before blaming them.

The two smallest credible cuts:

1. **Restore empty reasons for accepted rows.** Current instructions request a reason for every row; earlier probes measured substantial savings from refusal-only explanations.
2. **Remove generated `pageQuery` and judge `soft` output.** Neither drives the corresponding downstream operation today; stop paying models to emit unused fields.

Measure both; do not promise historical savings on today’s eight-row judge batches. Keep statuses, homepage evidence, and the reasoning judge. “Skip proving when records suffice” largely already exists, and the worker-synthesizer substitution already failed. [Measured judge findings](/Users/lahfir/Documents/Projects/Algominds/algo-backend/docs/solutions/judging-candidates.md)

## E. What to delete now with confidence

- Uncalled `mcpProvider`, its adapter-only tests, and unused `COMPANY`/`EMPLOYMENT`/`LINKEDIN` arrays.
- Gate’s unused `_results` argument and the parallel result-mapping plumbing.
- **The fake semantic checks in [`onboard-score.ts`](/Users/lahfir/Documents/Projects/Algominds/algo-backend/eval/onboard-score.ts):** two-word overlap, title substrings, and blanket bans on dated hard requirements cannot judge onboarding correctness—Carta directly contradicts that blanket rule.

Delete generated `pageQuery`/`soft` through the speed probe. **Do not call the inner controller a safe mechanical deletion:** it owns state and stop decisions despite production setting `maxRounds: 1`.

Keep validation, spend controls, retries, evidence and currently required bundle stubs. “Code standards secondary” is not permission to remove money or correctness safeguards.

## F. Where it is now—and when to stop

**The engine finds useful companies, but it is not reliably complete, fast, or correct end-to-end.** The latest large proof—not a fresh `894532f` baseline—produced Ondato **33/50 accepted companies, $2.05, nine minutes**, then **15/22 accepted buyers covering 12/33 companies**; Mstone **29 distinct accepted/30 requested, $0.86, ninety seconds**, then **69/69 accepted buyers covering 15/30 requested companies**; Form3 **27 accepted/30 requested, one rejected and one unresolved, $1.89, fifteen minutes**, then **71/77 accepted buyers with reported coverage 9/29 companies**. The ledger records **557 passing tests** on the merge; that is mechanics, not quality. My previous **7.5/10 companies and 6/10 people were engineering judgments**, not calibrated scores. [Proof ledger](/Users/lahfir/.claude/jobs/24a9762f/tmp/ledger.md:510)

Operational **10/10** should mean: every frozen, feasible scenario delivers **five distinct accepted companies, each with an accepted current buyer; no wrong delivered rows; complete evidence; and predeclared cost/time gates**, repeated on the frozen winner on another day, including held-out cases. Suggested latency targets—not measured performance—are **120 seconds for search companies, 300 for page-defined discovery, and 180 for people across five companies**.

Then stop changing the engine and monitor. That certifies the **five-company service**, not universal market recall or 500-company scale. If $20 runs out before confirmation, the verdict is **unproven**, not 10/10.


