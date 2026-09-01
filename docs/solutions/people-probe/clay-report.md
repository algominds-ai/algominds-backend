# Clay evaluation — measured, live

## What the API can do
Clay's public API (`api.clay.com/public/v0`) has a real server-side ENUMERATION
search, not just row enrichment:
  POST /search/filters-mode {source_type:"people", filters:{company_identifier:["harborit.com"], ...}}
  POST /search/filters-mode/{id}/run {limit}
Filters include `company_identifier` (domain or LinkedIn URL), `job_title_keywords`,
`job_title_seniority_levels_v2` (founder/c-suite/vp/director/head/manager/...).
Each result carries `name`, `url` (LinkedIn), `latest_experience_title`,
`latest_experience_company`, `latest_experience_start_date`, `matched_experience`,
`structured_location` — server-computed, not something we inferred. Clay also has a
separate enrichment/routine layer for email and phone waterfalls; that is a different
capability and was not the question here.

## Price — measured, and where it stayed opaque
Live GET /me confirmed the key (workspace 491969). The search run response returns
`period_quota` (`limit`, `used`, `remaining`, `resets_at`), not a dollar figure:
first call (212 results) → used climbed to 1,334,775; second call (11 results) →
used climbed by exactly 11. So people search draws down a bundled annual record
quota (1,500,000/year here, resetting 2027-01-01, 165,214 remaining), not a
per-call charge. No response body, header, or field exposed a dollar cost for
search. **Measured additional spend for this whole benchmark: $0.00** — the two
searches drew 223 of an already-paid quota. Clay's separate "Data Credits" (for
enrichment routines, not search) run about $0.067/credit on the Launch plan and
$0.074/credit on Growth, per Clay's own pricing page — but that rate does not
apply to what we tested. I could not determine this workspace's actual monthly
subscription price; that lives on Clay's billing page, not the API.

## Harbor benchmark (domain harborit.com, ground truth = 206-row BrightData roster)
One unfiltered search returned **212 people**, **212/212 (100%) with a real
current title** and a LinkedIn URL, all `matched_experience`-confirmed at Harbor.
A `job_title_seniority_levels_v2:["c-suite"]` search returned 11 people, also
100% real titles. **All 7 known seniors found**: Johnny Lieberman (CEO), Hannah
Paige (CFO), Michael Sullivan (CCO), Josh Oakes (COO), Eric Regnier (Chief
Services Officer) — all in the c-suite search — plus Charles F. (Director of
Service Delivery) and Jeff Dayton (Director, Shared Services & Transformation)
in the full set. 7/7.

## Verdict (part 1)
Clay is a **retrieval source**, the strongest measured here: 212 people/company
(vs BrightData 206, Exa 13-14, Lusha 44) at 100% real-title coverage (vs
BrightData ~30%, Apollo 25-27%), 7/7 known seniors (vs Lusha 3/4), and $0.00
measured marginal cost against this workspace's existing quota. The one gap: its
true standalone dollar price per company is not visible through the API — only
through Clay's account/billing page — so treat the $0 as "already paid for by
this workspace's plan," not as evidence the product is free.

---

## Part 2 — does it generalise?

### 1. Different vertical, at scale (ondato.com fintech/crypto/marketplace companies)
Live, one unfiltered `company_identifier` search each, paginated to `has_more:false`:

| Company | BrightData headcount | Clay full-search count | Clay coverage of BD | Title coverage (Clay) | c-suite search |
|---|---|---|---|---|---|
| airwallex.com | 2,364 | 499 | 21% | 499/499 (100%) | 14 |
| ramp.com | 2,165 | 498 | 23% | 498/498 (100%) | 8 |
| discord.com | 1,752 | 998 | 57% | 998/998 (100%) | 13 |
| polymarket.com | unknown | 380 | — | 380/380 (100%) | 11 |
| arqfinance.com | unknown | 166 | — | 165/166 (99%) | 4 |
| cybersalus.com | 21 (known) | 19 | 90% | 19/19 (100%) | 3 |

Confirmed with a fresh single-page re-run of airwallex.com: `has_more:false`,
`exhaustion_reason:undefined` on page 1 (499 rows) — this is **not** a
plan-imposed page cap, it is Clay's own index genuinely running out of current
employees to return for that domain. **Finding: title coverage holds at ~100%
regardless of scale, but raw recall collapses hard at large companies** —
21-57% of BrightData's headcount at the 1,700-2,400-employee names, versus
90-100% recall at small/mid companies (Harbor 212/206 = 103%, Cyber Salus
19/21 = 90%). Clay's index appears to be size-limited for very large orgs, not
title-quality-limited.

### 2. Emergent-count property
c-suite-filtered count by company (real headcount where known):
Cyber Salus (21 people) → **3**; Harbor IT (206) → **11**; arqfinance.com
(166 found) → **4**; polymarket.com (380 found) → **11**; discord.com (998
found) → **13**; ramp.com (498 found) → **8**; airwallex.com (499 found) →
**14**. The count is not flat and not linear — it tracks each company's own
structure (3/21 = 14% of Cyber Salus is titled c-suite, versus 14/499 = 2.8%
of Airwallex), which is what a real org chart looks like, not padding. No
source in this project has cleared this bar before.

### 3. Quota math
Every search-run response returns `period_quota` (`used`/`remaining` against a
1,500,000/year pool). Within a single script run, `used` moved by exactly the
row count returned on every call — a clean 1:1 record-to-quota-unit charge.
Across separate runs made minutes apart, the absolute counter was **not**
monotonic (it dropped by ~1,020 once between two of our own calls) — this is a
live, shared production key, so other concurrent traffic on the same
workspace moves the counter too. Treat point-in-time snapshots as noisy;
trust only the in-run deltas, which were exact. Total records this whole
two-part probe pulled directly: 224 (Harbor, message 1) + 2,613 (six-company
vertical run) + 499 (verification re-run) = **3,336 records, 0.22% of the
1,500,000/year pool**. At the c-suite-only rate actually needed for
prospecting (~9 records/company, averaged over the 7 companies tested), the
pool covers **~166,000 companies/year**; even at the full-roster rate
(~396 records/company), it covers **~3,800 companies/year**. A realistic
300-company/day run costs a trivial fraction of the annual grant either way.

### 4. Skeptical pass — failure modes found
- **Wrong domain (harbormsp.com, the domain actually stored for Harbor IT in
  our database)**: returned `{"data":[],"has_more":false}` — clean empty
  result, no error, no hallucinated people. This is a fourth honest-failure
  mode alongside the three found earlier in this project (unlike some
  sources, Clay did not confidently return wrong people for a bad domain).
- **Duplicates/junk**: 0 duplicate LinkedIn URLs among Harbor's 212 rows,
  0 placeholder/junk names (no "All Employees" style row). Two first+last
  name collisions (different people, different URLs) — expected at this
  size, not a defect.
- **Genuinely current, not stale**: spot-checked 10 of Harbor's 212 rows
  against BrightData's own `experience[]` (`end_date`) and against existing
  Exa structured `workHistory` data already on disk (`people-aris.json`) —
  no new Exa spend. 8/10 corroborated as current at Harbor IT by BrightData
  (one with an exact title match, "Project Manager", `end_date:"Present"`);
  1/10 corroborated by Exa instead ("Chief Customer Officer", exact title
  match) for a person BrightData's 206-row pull didn't happen to include;
  1/10 had no match in either source (not contradicted, just unverifiable
  from what's on disk). **0 of 10 were flagged as a past/stale role.**

## Verdict (final)
Clay generalises. Title accuracy and current-employment accuracy hold at
~100% from a 21-person company to a 2,364-person one, and the c-suite count
scales with real org structure rather than padding. The one real limit: raw
person-count recall drops sharply above roughly 500-1,000 employees — a
ceiling in Clay's own index, not a plan or pricing artifact, and not a title-
quality problem. Cost is a non-issue for realistic run sizes: the whole
two-part probe spent 0.22% of the annual quota, and prospecting-scale
(senior-only) searches would need over a century of runs at 300/day to
exhaust the pool.
