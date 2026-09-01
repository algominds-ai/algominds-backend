# Phase 2 — selector ablation (agent ABL), final scoring against completed R

**Framing, read before the numbers.** Arm (a) measures what the engine does today: the
selector sees only the stored ICP description. Arm (b) measures the ceiling if onboarding
captured buyer intent as a field: the selector also sees the rubric, written after reading the
client's stated intent, which encodes information the runtime pipeline does not have today. A
win for (b) is NOT a method win — it is the measured value of capturing intent at onboarding.

Same 20 companies and rosters (`ref/universe.json`, ids untouched, one fixed shuffle per
company, identical for both arms), same model, same id protocol, cap of 6 picks/call. No new
model calls for this pass — `ABL/score.mjs` re-read `ref/reference.json` (now complete: 20/20
companies judged, R populated for all 20, 68 verified buyers total) against the arm selections
already on disk in `ABL/progress.ndjson`.

## Pooled, 20 companies

| arm | avg precision | avg hard-neg rate | avg recall vs R (n=20) | basis explicit/inferred |
|---|---|---|---|---|
| a — ICP only | 0.469 | 0.277 | 0.508 | 32 / 115 |
| b — ICP + rubric | 0.947 | 0.000 | 0.696 | 89 / 10 |

## Paired comparison, pre-registered rule: only ≥6–0 discordant separates at n=20

**Precision** — b beats a in **18/20**, a beats b in **0/20**, ties 2. Discordant n=18,
two-sided exact sign-test **p≈7.6e-6**. 18–0 clears ≥6–0 → **SEPARABLE**: arm (b) has higher
precision.

**Recall vs R** — b beats a in **8/20**, a beats b in **1/20**, ties 11. Discordant n=9,
two-sided exact sign-test **p=0.0391** (nominally significant on its own). But the split is
8–1, not a clean sweep, so it fails the pre-registered ≥6–0 rule → **NOT SEPARABLE at n=20**.
Precision is where this ablation draws a real line; recall is not, at this n.

## The Ondato point — full per-pick lists, both arms, judged label + basis

Format: `title [LABEL/judge-basis]`. Compliance/AML/MLRO/risk titles in bold are the class the
rubric names HARD NEGATIVE.

**Airwallex** (a: prec 0.17, hardNeg 0.72, recall 0.25 | b: prec 0.86, hardNeg 0.00, recall 0.50)
a: **Sr Director Reg Compliance APAC** [NEG/contradicts] · **Assoc Director Reg Compliance Americas** [NEG/contradicts] · **Assoc Director Reg Compliance** [NEG/contradicts] · **Director Compliance & MLRO (NZ)** [NEG/contradicts] · **Assoc Director Global FCC Program** [NEG/contradicts] · Chief Product Officer [POS/explicit] · **Director Compliance & MLRO** [NEG/contradicts] · **Director Regulatory Compliance** [NEG/contradicts] · **Head of FCC & Risk Ops** [NEG/contradicts] · **Assoc Director Risk Ops Payments** [NEG/contradicts] · Senior Director Product Mgmt [POS/explicit] · Data Science Director, Risk & Payments [NEG/wrong_fn] · VP Product, Risk & Onboarding [POS/explicit] · **VP Global Head Financial Crime Compliance** [NEG/contradicts] · **VP Global Head of Risk** [NEG/contradicts] · **Chief Regulatory and Compliance Officer** [NEG/contradicts] · **VP Head Regulatory Legal & Compliance** [NEG/contradicts] · SVP Customer Experience & Ops [NEG/wrong_fn]
b: Chief Product Officer [POS/explicit] · Product Director, Ecosystem & Embedded Finance [POS/explicit] · Senior Director Product Mgmt [POS/explicit] · Head of Product Strategy & Ops [POS/explicit] · Global Head of Growth [POS/explicit] · Head of New Payment Flow [NEG/wrong_fn] · VP Product, Risk & Onboarding [POS/explicit]

**Arq** (a: 0.33 / 0.17 / 1.00 | b: 0.50 / 0.00 / 1.00)
a: Co-Founder & COO [INFLUENCER/wrong_fn] · Co-Founder & CPO [POS/explicit] · **Chief Legal Officer** [NEG/contradicts] · VP Product & AI Ops [POS/explicit] · Head of Cards [NEG/wrong_fn] · Co-founder & CEO [NEG/wrong_fn]
b: Co-Founder & CPO [POS/explicit] · VP Product & AI Ops [POS/explicit] · Head of Growth [POS/explicit] · Co-founder & CEO [NEG/wrong_fn] · Co-Founder & COO [INFLUENCER/wrong_fn] · Head of Cards [NEG/wrong_fn]

**Discord** (a: 0.08 / 0.17 / 0.25 | b: 1.00 / 0.00 / 1.00)
a: VP Trust & Safety [NEG/wrong_fn] · Global Head Product Policy [NEG/wrong_fn] · **Sr Director Product Law** [NEG/contradicts] · Director Public Policy EMEA [NEG/wrong_fn] · Director, Product [POS/explicit] · **Chief Legal Officer** [NEG/contradicts] · Sr Director Trust & Safety [NEG/wrong_fn] · Head Minor Safety [NEG/wrong_fn] · Head Youth Safety Policy [NEG/wrong_fn] · VP Product Design [NEG/wrong_fn] · VP Engineering [INFLUENCER/explicit] · Head Product Security [NEG/wrong_fn]
b: Director Product Mgmt [POS/explicit] · Sr Director Product Mgmt [POS/explicit] · Director, Product [POS/explicit] · Sr Director of Product [POS/explicit]

**Kraken** (a: 0.08 / 0.67 / 0.00 | b: 0.91 / 0.00 / 0.50)
a: **Chief Compliance Officer** [NEG/contradicts] · **Chief Compliance Officer UK** [NEG/contradicts] · **Chief Compliance Officer Canada** [NEG/contradicts] · COO/Head Bizops Consumer [INFLUENCER/funnel] · **Director Global AML/CFT** [NEG/contradicts] · Global Sr Director Client Exp [NEG/wrong_fn] · **Head Compliance Europe** [NEG/contradicts] · **Regional Head Compliance** [NEG/contradicts] · **Head Compliance & MLRO LATAM** [NEG/contradicts] · **Head Financial Intelligence Unit** [NEG/contradicts] · GM NA & Consumer Trade Ops [NEG/wrong_fn] · Head of Institutional Product [POS/explicit]
b: Director Head Product Mgmt [POS/explicit] · Sr Director Product, Trade/Earn/Borrow [POS/explicit] · Product Director Payments [POS/explicit] · Head of Growth [POS/explicit] · Global Director Head of Growth VIP [POS/explicit] · Derivatives Product Director [POS/explicit] · Head Institutional Product [POS/explicit] · Head Growth Consumer [POS/explicit] · Head Growth Pro & Desktop [POS/explicit] · Head Institutional Growth [POS/explicit] · GM NA & Consumer Trade Ops [NEG/wrong_fn]

**MoonPay** (a: 0.17 / 0.50 / 0.20 | b: 0.67 / 0.00 / 0.40)
a: **Global/US Chief Compliance Officer** [UNJUDGED] · **Head Compliance, AML & MLRO** [NEG/contradicts] · **Sr Director Financial Crimes Compliance** [NEG/contradicts] · **Sr Director Intl Compliance & UK MLRO** [NEG/contradicts] · VP Product - Ramps [POS/funnel] · SVP Operations [INFLUENCER/explicit]
b: VP Product - Ramps [POS/funnel] · Sr Director Product Mgmt [UNJUDGED] · Product Director [POS/explicit] · Head of Product (Commerce) [POS/funnel] · Head Lifecycle & CRM [POS/funnel] · CPO, Rhythm (different employer) [NOT_APPLICABLE]

**Polymarket** (a: 0.17 / 0.50 / 0.25 | b: 1.00 / 0.00 / 1.00)
a: **CCO Polymarket US** [NEG/contradicts] · **Chief Risk Officer, US Exchange** [NEG/contradicts] · **Head Financial Crimes** [NEG/contradicts] · Head of Product [POS/explicit] · GM Head of Payments [NEG/wrong_fn] · Head of Operations [NEG/wrong_fn]
b: Head of Product [POS/explicit] · Head Growth Product [POS/explicit] · Director, Growth [POS/explicit] · Chief Growth Officer [POS/explicit]

**Poshmark** (a: 0.36 / 0.18 / 0.33 | b: 1.00 / 0.00 / 0.33)
a: **Head of Fraud & Risk** [NEG/contradicts] · COO [INFLUENCER/funnel] · Chief Product Officer [POS/explicit] · SVP Product Mgmt [POS/explicit] · Sr Director Marketplace Ops [NEG/wrong_fn] · SVP Finance/Accounting/Legal [NEG/wrong_fn] · **AML Officer / Director Financial Crimes** [NEG/contradicts] · Director Payments Partnerships [NEG/wrong_fn] · VP Product Mgmt & Design [POS/explicit] · VP Marketplace Ops [NEG/wrong_fn] · Director Product & Ops [POS/explicit]
b: Chief Product Officer [POS/explicit] · SVP Product Mgmt [POS/explicit] · Sr Director Growth [POS/explicit] · Assoc Director Product Mgmt [POS/explicit] · VP Product, Growth [POS/explicit] · VP Product Mgmt & Design [POS/explicit] · Director Product & Ops [POS/explicit] · Sr Director Product/Marketing/Ops [POS/explicit]

**Ramp** (a: 0.09 / 0.73 / 0.20 | b: 1.00 / 0.00 / 1.00)
a: **Head Compliance & Fin. Crimes, BSA Officer** [NEG/contradicts] · **Global Head Fin. Crimes Compliance & Sanctions** [NEG/contradicts] · **Head Compliance Ops UK/EU** [NEG/contradicts] · **Head Compliance & MLRO Europe** [NEG/contradicts] · **Head of Risk** [NEG/contradicts] · **Head of Fraud Mgmt** [NEG/contradicts] · **Director Credit Risk** [NEG/contradicts] · **Deputy GC, Product & Regulatory** [NEG/contradicts] · Sr Director Product Mgmt [POS/explicit] · Director Product Ops [NEG/wrong_fn] · CTO [INFLUENCER/wrong_fn]
b: CPO [POS/explicit] · Director Product Mgmt [POS/explicit] · Head Strategic Growth Initiatives [POS/explicit] · Sr Director Product Mgmt [POS/explicit] · Co-founder, Growth [POS/funnel]

**Relay** (a: 0.00 / 0.00 / 0.00 | b: 1.00 / 0.00 / 0.50) — roster has no compliance seniors
a: Co-Founder & CTO [INFLUENCER/funnel] · VP Engineering [INFLUENCER/funnel] · Co-Founder & CEO [NEG/wrong_fn] · Head Strategy & Ops [NEG/wrong_fn] · Director Client Experience [NEG/wrong_fn]
b: VP of Growth & Marketing [POS/explicit]

**Seccl** (a: 0.17 / 0.33 / 0.33 | b: 1.00 / 0.00 / 1.00)
a: **Head of Risk** [NEG/contradicts] · **Chief Risk Officer** [NEG/contradicts] · Chief Product Officer [POS/explicit] · CTO [INFLUENCER/funnel] · Head of Launch [NEG/wrong_fn] · Director of Operations [NEG/wrong_fn]
b: Chief Product Officer [POS/explicit] · Growth Director [POS/explicit] · Growth Director [POS/explicit]

**Reading it:** in every Ondato company that has compliance/risk seniors in the roster, arm
(a) top-picks them under `function_contradicts_intent`. Arm (b) picks zero of them, anywhere.
Full id/name/url per pick is in `ABL/results.json`.

## Cost

`ledger("ABL").spent()` = **$0.6433** of the $1.00 cap. 40 `llm()` calls, 25/arm after chunking
the 4 rosters over 120 (Airwallex×3, Discord/Kraken/Ramp×2 each), MODEL_STRONG, json:true. No
spend this pass — pure re-score against the completed `ref/reference.json`.
