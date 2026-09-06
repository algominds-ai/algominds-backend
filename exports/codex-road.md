**The problem is that 4.29 measures progress on a small, repeatedly tuned benchmark—not readiness for a 10/10 promise.** The 21-point precision decline is the strongest warning. Coverage improving does not compensate for delivering wrong buyers. The comparison also bundles code, rubric and scoring changes, so it cannot establish which change helped.

Stopping at $29.82 was correct. The remaining $0.18 is not another experiment.

I inspected `p2/next` at `ae031f3`; I’m treating your final run figures as supplied evidence, not independently verified Braintrust results. Dollar figures below are **incremental planning allowances**, not guaranteed prices or guaranteed scores.

**1. Zero-spend work, in priority order**

| Priority | Prepare now | Additional vendor cost |
|---|---|---:|
| 1 | Freeze the final commit, both experiment exports, raw evidence, exact scored rows, rubric/key versions, timing and spend. Preserve 4.29 permanently. | $0 |
| 2 | Prepare `p2/eval-integrity`: offline replay, explicit failed-gate reporting, missing-accounting checks, and a run manifest that identifies every input. | $0 |
| 3 | Prepare `p2/latency`: reconstruct Mstone’s critical path from saved timestamps—retrieval, selection, verification, polling, retries and queueing. Change only the demonstrated bottleneck. | $0 |
| 4 | Prepare `p2/buyer-contract`: original and proposed buyer wording, with concrete positive/negative examples. Keep contract changes out of engine-fix comparisons. | $0 |
| 5 | Prepare `p2/coverage-probe`: list uncovered companies, existing roster evidence, and whether each miss occurred in retrieval, selection or verification. Identify the smallest existing fallback worth testing. | $0 |
| 6 | Prepare exact run order, isolated arm names, credential-presence checks, budget reservations and stopping conditions. Run local checks with paid calls disabled. | $0 |

Two concrete evaluation defects deserve attention before another paid run:

- [The scorer](</Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-next/eval/engine-score.ts>) permits `totalSeconds === null` through its time gate. Missing timing must not satisfy a timed contract.
- [People keys](</Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-next/eval/people-key.ts>) grow from **delivered people**. That supports precision labeling; it cannot establish which buyers the engine missed. Prepare an independent company roster with evidence date, employment, responsibility and unresolved status.

For credentials: inventory what is configured without printing secrets or making billable “test” requests. For answer keys: missing evidence stays unknown; it does not become an acceptance label.

**2. Cheapest credible attempt at 7+**

First, the arithmetic matters. With gates passing:

`profile score = buyer coverage × buyer precision`

Mstone at 18/18 and 4/5 coverage would score **0.8**, not 1.0. Clearing its timing failure alone takes the overall rating from **4.29 to 5.43**.

A plausible partial-recovery route is:

`10 × (aris 1 + form3 1 + dental 1 + mstone .8 + carta .6 + hvac .6) / 7 = 7.14`

That assumes no regression and every relevant gate passing. It leaves Ondato at zero. It is an intermediate engineering result, not satisfaction of the owner’s condition.

| Order | Paid step after free preparation | Budget allowance |
|---|---|---:|
| 1 | Finish/re-run HVAC’s people stage against the saved strict company set, if supported. Its people quality is currently unmeasured because the watchdog stopped it. | **$0.50–$1.50** |
| 2 | Run Mstone once after a trace-supported latency fix, under the original 400-second bar. | **$1–$2** |
| 3 | Probe Carta’s selection on the saved roster; then run its people stage if the probe fixes the actual violation. | **$0.50–$2** |
| 4 | Only if needed, probe one Ondato coverage failure using the existing fallback. Stop if the evidence indicates unavailable data rather than a repairable engine miss. | **$1–$2** |
| 5 | Confirm one frozen build across all seven, with two trials each and independently reviewed new outputs. | **$8–$14** |

**Ask for a $25 top-up ceiling**, released in those stages. Expected attempt: roughly **$10–$22**; the balance covers variance. That buys a bounded attempt and confirmation, not a promise of 7+. Reconcile actual stage costs before each release.

Three judgments:

- **Mstone: the engine misses the frozen bar; the bar’s product validity is unproven.** Its [documented origin](</Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-next/eval/profiles.ts:9>) is extrapolation from earlier company runs. To meet 400 seconds requires removing 235 seconds, a **37% reduction**. The $0.86 people result is encouraging economics, not latency success. Ask the owner whether roughly eleven-minute asynchronous delivery is acceptable. If yes, version a new contract prospectively; do not repair the old score by changing its bar.
- **Carta: “no finance owner on the roster” is observable, but absence from a retrieved roster is not absence from the company.** Under the original rubric, the founder at 65 staff remains wrong. A clarification preserving that contract is: “A founder/CEO qualifies below 50 employees when they own finance and no dedicated finance owner exists; an incomplete roster does not establish absence.” Removing the size condition requires owner approval.
- **Ondato/HVAC: diagnose the empty company before buying another provider.** Was its buyer absent from retrieval, discarded during selection, or lost during verification? Those require different repairs. Keep strict company qualification; smaller businesses do not justify weaker geography or evidence.

**3. What could honestly support “10”**

**No finite program can establish universal perfection.** It can establish “10/10 on this frozen, independently evaluated acceptance suite.” The owner must accept that scope—or “10 or nothing” is not an executable acceptance condition.

The program needs:

- Independent buyer rosters per company, assembled without seeing engine selections. Company participation or reliable internal records may be necessary to establish completeness.
- Frozen buyer definitions, exclusions, geography, spend and latency requirements.
- Separate measurements of company fit, identity, current employer, buyer fit, company coverage and roster recall. Unknowns remain visible.
- Second-day runs, including fresh companies; repeating only development examples is insufficient.
- A paired provider-coverage test against those independent rosters. Another provider’s output is evidence to adjudicate, not truth.
- Runs requesting **50 and 100 companies per profile**, repeated on a second day. Predeclare scale-specific operational bars; the current five-company bars cannot sensibly govern those runs unchanged.
- A held-out final evaluation after tuning ends. Any subsequent fix requires new confirmation.

A transparent costing model:

| Work | Scope and assumption | Incremental cost |
|---|---|---:|
| Repair and seven-profile confirmation | Bounded program above | **Up to $25** |
| Provider comparison | Small stratified panel, existing accounts, incremental retrieval/enrichment | **$20–$60 allowance** |
| Scale executions | `7 × (50 + 100) × 2 days = 2,100` company executions; assume **$0.20–$0.60 each** | **$420–$1,260** |
| Execution reserve | Approximately 25% for variance/retries | **$110–$340** |
| Independent truth and adjudication | Approximately 700–1,000 unique companies; **200–500 hours at $50/hour**, including review and freshness checks | **$10,000–$25,000** |

**Planning total: roughly $10,600–$26,700, excluding engineering and new provider subscriptions.** Existing qualified staff can reduce cash outlay, but their work still costs time. Inaccessible complete rosters can block the claim regardless of budget.

The execution estimate is deliberately provisional. Exa currently lists Agent runs at **$0.012–$1.00**, with some enrichment charged separately; a cheap search request does not price the full verification chain. [Current Exa pricing](https://exa.ai/pricing)

From the owner, you need **a scoped definition of 10, approved buyer rules and latency expectations, an independent adjudicator/roster source, provider access, and staged spending authority**. Money alone does not resolve those decisions.

**4. What I would change before merge**

- **Narrow the new dedupe behavior.** [It treats matching name/title/company as sufficient identity proof](</Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-next/src/core/people/person-identity.ts:42>), even with different LinkedIn URLs. That can suppress distinct people. Keep canonical-URL dedupe; require corroboration for cross-URL identity merging. Its alias bookkeeping also needs a check for chained matches.
- **Separate Ondato/Form3 rubric changes from the engine merge.** Form3 introduces a roughly 2,000-person director threshold, additional exclusions and buyer geography. Ondato replaces a founder size condition with roster-dependent eligibility. These are substantive contract changes, not merely wording.
- **Fix missing-time acceptance before trusting the scorer.** Keep the stricter scorer otherwise.
- **Keep HVAC strictness and Carta/Dental’s restored original rubrics.** Do not weaken them to recover points.
- **Keep demonstrably unused-code deletions. Hold the judge-output optimization apart until a paired comparison explains its effect.** The precision decline does not prove that optimization caused harm, but the bundled experiment does not clear it either.

Owner note:

> The phase closed at $29.82/$30 with a final rating of 4.29/10, up from 2.86. Three profiles passed; Mstone missed latency despite clean delivered people, Carta and Ondato retained correctness/coverage failures, and HVAC’s people stage was stopped by the budget watchdog. Precision declined by 21 percentage points in the reported experiment comparison, so this is not a release-quality result or evidence of complete buyer discovery. No further paid runs are authorized. We can prepare the fixes and evaluation offline; I recommend a staged $25 top-up for a bounded recovery attempt, contingent on confirming buyer rules and latency expectations. An honest scoped 10/10 claim additionally requires independent rosters, held-out confirmation, second-day repeats and scale evaluation, with a separate budget.

No files were changed or paid evaluations run during this review.


