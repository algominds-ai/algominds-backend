### 1. Headline claim

The strongest objection is construct circularity. Arm (b) receives the rubric, and buyer correctness is then judged by a model implementing that same rubric. Two-source verification confirms identity, employer, and title—not buyer fit. Thus 0.95 primarily measures rubric-conditioned selector agreement with a rubric-conditioned judge.

Also, the treatment is richer than “capture buyer intent as a field”: it supplies positive rules, exclusions, hard negatives, and company-size carve-outs. The defensible claim is:

> On this fixture, explicit buyer criteria eliminated most disagreement with the experiment’s buyer rubric at zero incremental retrieval cost.

It does not yet establish 0.95 real-buyer precision or that selection is generally the dominant failure.

The cheapest separating check is blinded client labeling: randomize and deduplicate the top three candidates from both arms for the preselected five Ondato and five Aris companies. Show name/title/company only—no arm, rubric, or model basis.

### 2. Retrieval

The honest statistical conclusion is: **no retrieval benefit was demonstrated; effects of practically relevant size remain uncertain.** “Adds nothing” asserts equivalence, which was not tested. Operationally, however, there is no evidence to justify shipping the LLM gate: equal recall wins/losses, zero round-two recovery, and avoidable provider cost.

To test the generic policy, pre-register a smallest worthwhile company-level lift; detecting roughly 20 points needs about 40 paired companies under optimistic assumptions, and more with reverse wins.

A cheaper, sharper test is the stratum where benefit appeared: small MSPs whose senior-band roster has no HR/recruiting owner. The three verified managers—at only two companies—are enough to retain a **deterministic, keyworded Clay manager fallback** because it is cheap and produced real incremental buyers. They do not justify an LLM planner, universal manager retrieval, or broad “growth” keywords.

### 3. Meaning of recall 0.70

“Recall 0.70” is the macro-average, across companies, of:

`selected IDs ∩ R / R`

Here, R contains only the verified members of at most six judge-positive candidates drawn from Clay’s eight senior bands.

It does not mean 70% of:

- all real buyers at those companies;
- all 68 verified reference people pooled together;
- all judge-positive Clay candidates;
- manager-level or provider-exclusive buyers;
- buyers absent from every tested source.

Ntiva is a clear reference-cap artefact, not a selector failure. It has 26 judged positives, but only six were checked and five entered R. Arm (a) selected five positives and arm (b) six positives, all outside those five IDs, producing recall zero. The score is correct against the capped R but misleading as buyer recall.

### 4. Production method

1. Onboarding: capture account ICP separately from buyer-owned workflow, budget/decision role, explicit exclusions, and size-dependent exceptions.
2. Resolve company in Clay by domain; fallback to stored LinkedIn company URL; stop as unresolved if neither works.
3. Retrieve Clay’s eight senior bands.
4. For small MSPs lacking a senior HR/recruiting owner, add Clay’s keyworded manager band.
5. Do not run Apollo or Exa Agent automatically; current identity yield does not justify them.
6. Deduplicate by canonical LinkedIn URL.
7. Select at most six IDs using the captured buyer criteria; return an honest empty result if none fit.
8. Verify with Exa structured employment data **and** open-web model reading.
9. Treat disagreement or missing evidence as unknown and exclude it.
10. Rank/personalize only after eligibility; reuse verification evidence, with BrightData on demand.

Before changing the engine, measure blinded client-labeled selector precision. Pass only if the intent arm achieves **≥90% precision, ≥20-point lift over raw ICP, and zero intent-contradicting picks**.