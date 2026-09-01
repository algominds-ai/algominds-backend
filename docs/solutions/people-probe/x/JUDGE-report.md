# JUDGE report

**Spend: $2.7933 of $2.80.** Budget is exhausted; no further paid calls were made.

## Controls
Sourced from `bd-aris.json` (full BrightData rosters, all 10 Aris companies) and `ref/universe.json`
(Clay senior bands, all 10 Ondato companies). Structural title/keyword matching only; every control
was independently confirmed by MODEL_FAST against the rubric before use. 25 ambiguous matches were
excluded on structural/second-model disagreement (compound titles, wrong-company mentions inside
multi-role bios, narrow-scope suffixes like "Growth Marketing"). **wrong_employer: 0/8 confirmed** —
titles built to say "at OtherCompany" were still often labeled NEGATIVE by MODEL_FAST rather than
NOT_APPLICABLE; per Codex's point 3 this class tests the verifier, not buyer-fit, so it is excluded
from the gate.

Two required additions from review: **vocab-free intent-contradicting** (function matches but no
"compliance/AML/KYC/MLRO/financial crime/legal/DPO/CFO/finance/sales/marketing/CISO/board" words) —
15 raw, 12 confirmed, 7 landed in LOCKED (Controller, Corporate/Financial Controller, Trust & Safety,
General Counsel, Chief Risk Officer). **Context-dependent positives** (Owner/CEO/Market President,
verdict depends on company not string) — only 5 exist in the sourced data (4 Ntiva Market Presidents +
1 Owner/CEO), short of the requested 10. Reported, not manufactured: no Ondato company in this fixture
is under the rubric's ~100-employee founder/CPO carve-out (smallest is Arq at ~159-229).

## DEV / repair
One repair cycle, applied to the CONTROL POOL not the judge prompt: removed ambiguous compound-title
matches (bare "Vice President" with no department, cross-company mentions inside multi-role bios,
dual-mandate titles like "Director of Finance and HR"). First DEV: 0 FP, 78.6% recall. After repair:
0 FP, 93.8% recall (15/16).

## LOCKED (run once, final)
**76 negatives, 0 FP (upper bound 3/76 = 3.9%). 24 positives, 92% recall (22/24).** Headline:
**36 intent-contradicting negatives, 0 labeled POSITIVE or INFLUENCER**, incl. all vocab-free ones.
Two misses, both defensible: "HR Manager at Harbor Networks" → NOT_APPLICABLE (Harbor Networks and
Harbor IT are the same company under two brand names in the source data — a data artifact, not a
judge error); "Senior Director of Product Design" → wrong_function (product DESIGN is UX leadership,
not the product/growth ownership the rubric wants — my keyword match should have excluded "design" as
a narrow-scope suffix; a control-quality gap, not a judge gap).

## Universe (U) + new candidates
All 20 companies labeled (Airwallex/Discord/Kraken/Poshmark/Ramp chunked, >120 candidates, by
inferred band). MoonPay: 24/80 malformed ids on one call — a real coverage hole, not silently
dropped. GATE's 83 "beyond Clay" candidates labeled: **0 positive at Airwallex (38) and Ramp (29)**,
4 positive total (Centre Technologies, Harbor IT) — the fan-out's big-company finds were noise by
this rubric.

## Verify + reference.json
Budget ran out mid-pass: **verified 15, contradicted 2, unknown 4** (21 calls) across only 5 of 20
companies (Airwallex, Arq, Discord, Kraken, MoonPay) — 15 companies have judged positives but **empty
R**. New-candidate positives: 3 verified, 1 unknown (all 4). `web.empty` count: 0. Spot-check: 7 of 10
planned (budget), **7/7 agreement** MODEL_FAST vs MODEL_STRONG. exa-web ledger: 32/32 rows at exactly
$0.007.

## Caveat
A duplicate background process re-ran Airwallex/Arq/Discord once before I caught it, wasting ~$0.15-0.2
of budget — the direct cause of the incomplete verify pass. Conclusion: **buyer fit is measurable**
(gate passed), but **R is incomplete** — 15 companies need verify() before ABL/GATE scoring against R
is trustworthy for them.
