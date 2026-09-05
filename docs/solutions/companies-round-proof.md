# One round judges its gated candidates in slices, and every proof is checked against the page and the window

## The problem

Measured on six profiles with three companies per run (eval branch `eval/braintrust`, experiments
`1e19d8dc9bd6-baseline` through `fe2db010565d-combined2` in the Braintrust project `algo-backend`):

- A round judged only the first `count × judgeCandidateMultiple` gated candidates. When the judge
  refused most of them the run paid for a whole new round, and a new round is two model calls of
  15 to 50 seconds each. Exa search itself takes under one second. Three of six profiles needed
  two or three rounds for three companies.
- A record that understated headcount passed the bound while the company's own description said
  "over 1,800 team members" (dental, hvac profiles, three cases). The judge did not catch it.
- A proving search had no date bound, so a 2019 or 2021 case study proved a two-year window
  (three cases on the form3 profile).
- On the agent route a quote the page check could not find on the cited page still reached the
  judge as evidence, so an unverifiable quote counted as page proof (carta, form3).

## The fix

- `round.ts` `judgeSlices`: a round short of its count judges the next slice of the candidates it
  already gated, at most three slices, before the run starts another round. Brand collapse stays
  within a slice. Measured: every profile finished in one round; mstone 97 s → 60 s per run;
  form3 189 s → 139 s; total cost per arm −16%.
- `limits.ts` `statedHeadcount`: a headcount the description states is bounded like the record's.
- `proof.ts` `provingDemand`: a proving search carries `startPublishedDate` = today − windowDays.
- `proving.ts` `reproveUnverified`: an agent row whose quote is not on its page is stripped of that
  evidence and sent through the proving pass; `applyRowEvidence` copies the proving page onto the
  stored capture so `company.data.result` names the page that proved the row on both routes.

## What stays open

Agent-route runs sit on the 150 to 180 second bars in every arm; the time is model latency, not
search. Requirements that name an exclusion too literally (an "IT contractor reseller" text that
means IT services firms) let the judge keep companies the profile excludes; that is an
onboarding defect, not a search defect.
