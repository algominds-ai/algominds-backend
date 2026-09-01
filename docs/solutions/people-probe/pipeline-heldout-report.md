# Held-out pipeline probe — generalization test (form3.tech)

## Target chosen

Seller icp_id `9ecd99e9-0345-4c2c-9600-62cbe2b54333` in the database, domain
`form3.tech`. Chosen over the already-used `prof-breach.json` (that one is
`example-supplychain.com`) because the brief asked to prefer a different
held-out profile when the database has one. ICP: organizations running
Kubernetes or comparable distributed infrastructure at genuine scale, in-house
engineering team, uptime-critical or regulated, more than 500 employees,
UK/Ireland/Continental Europe/North America. Buyer titles: CTO, CISO, Head of
Platform, Head of Cloud, Head of Infrastructure, VP Engineering, and
Director-level equivalents.

10 companies are attached to this icp_id. Picked the first 5 in database order
(unbiased): Spotify, Swisscom, Zynga, Pinterest, Marriott International.

## Finding 1 — BrightData outage (stage 1 as originally briefed)

`api.brightdata.com` refused every TCP connect attempt for this probe from
first detection at about 12:31 to a last confirmed-still-down check at
12:50:39, continuously (roughly 19 minutes, ~20 attempts). Exact error:
`TypeError: fetch failed ... ConnectTimeoutError: Connect Timeout Error
(attempted addresses: 3.232.8.188:443, 3.232.71.244:443, timeout: 10000ms)
code: 'UND_ERR_CONNECT_TIMEOUT'`. Raw curl gave exit 28 (connect timeout) on
every attempt. DNS resolved fine to those two AWS addresses. In the same
window, `google.com` (200) and `api.exa.ai` (reachable) both worked normally,
so this was a network-level failure specific to BrightData's host.

Confirmed shared, not local to this probe: no download artifact under
`scratchpad/bd/` anywhere in the shared workdir has a write time after
12:26:16, across the whole window this probe was failing (the one later file,
`offline-summary.json` at 12:37:26, is an offline analysis of rows fetched
before the outage, not a new fetch — its presence is itself evidence that at
least one other agent had already pivoted away from live BrightData calls by
then). Team-lead independently confirmed the same thing minutes later and
called it full account saturation from multiple probes hitting BrightData at
once, then directed standing down and running the rest of the pipeline
without it — so ENRICH (the LinkedIn-activity personal hook, which needs a
BrightData row) is reported below as blocked, not worked around.

## Finding 2 — a BrightData-free pipeline, measured end to end

Per team-lead's redirect, ran GROUND → SELECT → RETRIEVE+VERIFY → JUDGE on
Apollo + Exa only, with BrightData's role (an observed-title source) replaced
by Apollo. ENRICH stayed blocked.

### Stage 2 — GROUND (Apollo, free)

First pass (seniority-only query, `per_page: 25`) missed real infra/security
titles at some companies — Spotify's 24-title sample was pure
music/marketing/HR, with zero infrastructure or security roles, which would
have made the SELECT stage look like a false "no buyers here" rather than a
sampling gap. Fixed by widening `per_page` to 100 and adding a
`person_titles` probe for the ICP's own named titles (CTO, CISO, Head of
Platform/Cloud/Infrastructure, VP Engineering, Director-of-Infrastructure
equivalents) — 40 Apollo calls total, all free, completed within a single
60-second tool call (not separately timed, so no per-call figure is
reported). The probe recovered real titles at every company, including
Spotify ("Engineering Manager - Core Infrastructure", "VP of Engineering,
Head of AI/ML").

| Company | Apollo total_entries (senior) | distinct observed titles |
|---|---:|---:|
| Spotify | 730 | 108 |
| Swisscom | 869 | 122 |
| Zynga | 198 | 88 |
| Pinterest | 401 | 106 |
| Marriott International | 7146 | 96 |

### Stage 3 — SELECT (OpenRouter, gpt-4o-mini)

Model chose buyer titles from the observed list only; titles not on the list
were dropped and counted as invented.

| Company | proposed | valid (kept) | invented |
|---|---:|---:|---:|
| Spotify | 9 | 4 | 5 |
| Swisscom | 14 | 14 | 0 |
| Zynga | 10 | 3 | 7 |
| Pinterest | 6 | 6 | 0 |
| Marriott International | 11 | 10 | 1 |

Invented titles happened on 3 of 5 companies in the scored run (Spotify 5,
Zynga 7, Marriott 1). To see what kind of invention this was, re-ran the same
prompt standalone for Spotify and Zynga afterward (a separate, unscored LLM
call — the exact invented titles vary call to call since nothing is seeded,
so this shows the *pattern*, not the scored run's literal list). In that
re-run, every invalid title was the *canonical* form named in the ICP text
itself — "CTO", "CISO", "VP Engineering", "Head of Cloud", "Head of
Infrastructure" — substituted when the real observed title was a messier
variant ("Chief Architect, VP of Engineering", "Head of Cloud FinOps and Cost
Engineering") that the model judged as not close enough. This is a different
failure mode than the known "27% of planned titles exist" problem: here the
model has a genuinely matching title in front of it and substitutes the tidy
generic form anyway. Worth a dedicated, larger-sample check before this
constraint is trusted at scale.

### Stage 4 — RETRIEVE + VERIFY (Exa, category people)

One combined query per company, same shape as the baseline (`<titles joined
by ", "> at "<Company>"`, `numResults: 10`). A result only counted as
verified when Exa's structured `workHistory` showed a current entry (`dates.to
=== null`) at the target company.

| Company | raw retrieved | verified current | verified/Apollo total_entries |
|---|---:|---:|---:|
| Spotify | 10 | 10 | 1.4% |
| Swisscom | 10 | 10 | 1.2% |
| Zynga | 10 | 10 | 5.1% |
| Pinterest | 10 | 10 | 2.5% |
| Marriott International | 10 | 10 | 0.14% |

Every retrieved result verified as current in this run (10/10 each company) —
`numResults` was the binding constraint everywhere, not the verification
filter, so this table cannot say whether a bigger company yields more real
buyers; it only shows that Exa's people search stayed accurate at the fixed
cap. Answering the yield question would need a per-title arm (5 companies ×
~6 titles × $0.007 ≈ $0.21, not run — out of scope for this pass, flagged as
the natural follow-up).

Checked Marriott's 10 verified rows individually for franchise/subsidiary
leakage (a real risk with a name like "Marriott" — JW Marriott franchises,
Marriott Vacations Worldwide is a separate public company) by reading the
`employer` field Exa returned for each: all 10 read exactly "Marriott
International", with titles that plausibly own cloud/infra/security budget
(Global CTO, SVP & CISO, VP Security Architecture & Engineering, several
Director/Senior Director Cloud/Infrastructure roles). No leakage found in
this sample.

### Stage 5 — ENRICH: BLOCKED

Needs a BrightData row's `activity` array. Not run. Personal-hook coverage
for these 50 selected people is **not measured** (blocked, not zero) — this
is a real gap in the BrightData-free path, not an oversight; team-lead's
instruction was to mark it blocked rather than substitute anything.

### Judge (heldout-judge.mjs, same model/prompt/schema as the 72% baseline)

**33/50 correct — 66%** overall. 2 unclear, 15 incorrect.

| Company | correct | judge score |
|---|---:|---:|
| Zynga | 5/10 | 50% |
| Spotify | 5/10 | 50% |
| Swisscom | 7/10 | 70% |
| Pinterest | 8/10 | 80% |
| Marriott International | 8/10 | 80% |
| **Median** | | **70%** |

The two weakest companies, Spotify and Zynga, are also the two with the most
invented (non-observed) titles in the SELECT stage (5 and 7 respectively);
Swisscom, Pinterest, and Marriott had 0, 0, and 1 invented titles and scored
70–80%. That correlation is consistent with the invented-title finding above
being a real quality driver, not a side issue — though with 5 companies this
is suggestive, not proven.

At n=50 the standard error on a 66% proportion is about 6.7 points, so 66%
is within one standard error of the existing 72% held-out-profile baseline
and the 74%/71% Ondato/Aris combined-query-N=10 baselines — read this as
**roughly at baseline**, not clearly below it. One input-shape note: this
run's title pool came from Apollo-probed real titles at five much larger,
functionally broader enterprises (Marriott alone: 7,146 senior matches
spanning hotel operations, HR, and infra) than the two sellers the baseline
was built on, which is exactly the generalization stress this probe was
meant to apply.

## Cost and time table

| stage | cost (measured) | time |
|---|---:|---|
| GROUND (Apollo, 5 companies, 40 calls) | $0 | ~20–30s total |
| SELECT (OpenRouter, 5 companies) | $0.00109 | 1.5–8.4s per company |
| RETRIEVE+VERIFY (Exa, 5 companies) | $0.035 | 0.4–1.0s per company |
| ENRICH | blocked | — |
| JUDGE (50 rows, 3 batches) | $0.10404 | — |
| **Pipeline total (excl. blocked stage 1/5)** | **$0.14013** | — |

Exa spend: **$0.035** of the $0.75 cap. BrightData spend: **$0** (stage 1
never completed a call). Cost per verified buyer, end to end through
verification: **$0.0007** at every company — flat because `verifiedCount`
was pinned at the `numResults: 10` cap in every case, so this number reflects
the cap, not a real per-buyer economics answer; a meaningful cost-per-buyer
figure needs the uncapped per-title arm noted above.

## What was not run

- Stage 1 (BrightData roster retrieval) and stage 5 (personal-hook
  enrichment): blocked by the shared BrightData outage for this entire probe
  window.
- The uncapped per-title Exa arm that would answer whether larger companies
  yield proportionally more real buyers.
- A second, larger sample re-run of the SELECT stage to get a stable rate for
  the "invents the canonical title instead of the messy real one" failure
  mode (observed on 2/5 companies here, small sample).
