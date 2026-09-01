# Finding the right people: the measured method

Twenty real companies, two real sellers, one pre-registered experiment. Every number below
was measured on 2026-09-01 and every threshold was written down before the result existed.
Design: `people-probe/x/DESIGN.md`. Reviews: `people-probe/x/CODEX-REVIEW-1.md` and
`CODEX-REVIEW-2.md`. Running log with every mistake: `people-probe-log.md`.

## The finding that locates the failure

The engine's precision problem is not retrieval. It is selection under a profile that never
names the buyer.

Identical rosters, identical model, identical candidate ids, a cap of six picks. The only
difference between the two arms is what the selector reads.

| selector reads | precision | intent-contradicting picks | companies where it won |
|---|---|---|---|
| the stored ICP only | 0.47 | 28% of picks | 0 |
| the stored ICP plus the client's buyer intent | 0.95 | 0 | 18 of 20, two ties |

Two-sided sign test p < 0.001 against a pre-registered rule of six-to-nothing. At companies
over 500 people the stored-ICP arm reaches 0.16.

What that looks like at Ramp, an Ondato target. Given the ICP alone the selector chose the
Head of Compliance and Financial Crime, the Global Head of Financial Crimes, the Head of
Compliance Operations, the Head of Compliance and MLRO, the Head of Risk, and the Head of
Fraud Management. Given the buyer intent it chose the CPO, the Director of Product
Management, the Head of Strategic Growth, the Senior Director of Product Management, and the
Co-founder for Growth. Kraken, Airwallex, Discord and Seccl repeat the pattern.

The honest reading, from the second review: explicit buyer criteria removed almost all
disagreement with the experiment's buyer rubric, at zero retrieval cost. The rubric encodes
what the client said. Whether the rubric matches what the client would actually mark is what
the spot-label sheet tests, and nothing else in this experiment can.

## Retrieval: no benefit from an LLM front gate was demonstrated

With the selector fixed, an LLM-planned fan-out across Clay, Apollo, Exa search and the Exa
agent was compared against Clay's eight senior seniority bands alone.

| retrieval | precision | recall against the reference | beyond the free roster | second round |
|---|---|---|---|---|
| Clay senior bands | 0.95 | 0.70 | — | — |
| LLM front gate | 1.00 | 0.71 | 83 found, 44 labelled, 3 verified buyers | 0 recovered at all 7 companies it fired |

Paired recall 4–4, precision 4–0: not separable at twenty companies. On the eleven companies
where recall can discriminate at all, both reach 1.00 at nine. The planner rejected no filter
values and, unprompted, almost never called Apollo or Exa: it recognised the free roster
already covered senior slices and paid only for Clay's manager band. Its three real finds are
the sole HR or recruiting manager at a small MSP. That is one deterministic fallback, not a
planner.

Apollo's surnames are obfuscated and never resolved to a person another provider confirmed;
it is a lead source. One Exa agent run cost $0.225 for four people already in the roster.

## Verification: two sources, and the honest unknown

A person is verified only when Exa's structured people index shows an open-ended role at the
company and a model reading the open web confirms the claim. The two are independent of each
other; only the web read is independent of LinkedIn.

93 judged positives checked, at most six per company: 68 verified, 7 contradicted, 18
unknown. Every company has at least one. Cost $0.011 per person checked. Earlier, on a
control set, the same rule confirmed 8 of 12 real people and 0 of 6 controls, catching a
departed employee that the web alone had confirmed.

The web read returns an outreach hook in the same call. 30 of the 68 verified buyers came
with a specific event (a hire, a launch, a quote, a role change); 37 carry a date inside 180
days. BrightData's collected profile, run only on the 38 without one, added 7 more for $0.095.

## The judge, and what it can and cannot say

A rubric judge, validated on a locked split used once: 76 negatives with no false positive
(upper bound 3.9%), including 36 whose function matches the ICP text but contradicts the
client's intent and 7 whose titles carry no ICP word at all; full recall on the locked
positives. The same roster labelled twice on identical input moved one positive and four
influencers, so single-company figures carry about ten points of label noise. The eighteen-
to-nothing result sits far outside that; individual company precisions do not.

Recall against the reference is Clay-bounded and capped: the reference holds the verified
members of at most six judge-positives per company. At Ntiva, 26 judged positives and a
reference of 5, both selector arms scored zero at precision 1.0. That is the cap.

## The method

| stage | does | provider | fallback | cost |
|---|---|---|---|---|
| 0 onboarding | capture the buyer separately from the account: the workflow they own, budget or decision role, explicit exclusions, size-dependent exceptions | model, seller's site and brief | ask the client | once |
| 1 identity | resolve the company by domain; if empty, by the stored LinkedIn company URL; if both fail, stop as unresolved | Clay | none, by design | ~0 |
| 2 retrieve | the eight senior bands, one call each; at a small MSP with no senior HR owner, add the manager band keyworded for HR and recruiting | Clay | Exa people search per persona | quota |
| 3 dedupe | canonical LinkedIn URL, then name key | code | — | 0 |
| 4 select | at most six candidate ids plus a closed-set basis; the model never emits a title; an empty result is a valid result | model with the buyer criteria | — | $0.02 |
| 5 verify | structured index and open-web read must both confirm; disagreement or silence is unknown and is excluded | Exa, model | none; unknown stays unknown | $0.011 |
| 6 context | keep the hook the verifier read; append as evidence | free | BrightData row on demand | $0.0025 |

No Apollo, no Exa agent, no second round, no LLM planner in the default path. A twenty-
company run costs about one dollar.

## Four ways to get a confident empty answer, each with its guard

A wrong stored slug returned zero rows. A wrong-identity slug returned 104 real strangers
that looked normal. A saturated BrightData account hung with no status code. A reasoning
model given too few tokens returned empty text that parsed as unknown. The guards: resolve
identity before retrieval; treat a timeout as unknown, never as empty; distinguish an empty
model reply from a genuine unknown; and fail closed on any filter value outside a provider's
real set.

## Before the engine changes

Measure blinded, client-labelled selector precision on the delivered sheet. Pass only if the
intent arm reaches at least 90% precision, at least a twenty-point lift over the stored-ICP
arm, and zero intent-contradicting picks. The sheet holds 58 shuffled rows mixing verified
buyers with judged hard negatives; twenty labelled rows are enough to start.

## Spend

$5.61 for everything, including building and validating the judge. Two agents lost money to
orphaned background processes ($0.37 and about $0.20) and both are in the ledger. The
expensive providers of the earlier probe, BrightData rosters and treg, are not in the method.
