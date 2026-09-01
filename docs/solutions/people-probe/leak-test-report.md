# Buyer leak rate — kill test for "BrightData roster as denominator"

Stood down on fresh BrightData calls per instruction (account saturated, HTTP 000 hangs).
Final figure uses only drains verified complete: 2 pulled fresh this session, 3 reused
verbatim from a prior, already-verified pull on disk (`bd-aris.json`). arqfinance has no
verified drain and is dropped from the pooled figure rather than reported on a guess.

## Method
1. Drain: `bdSearch` paged to exhaustion per company slug. Verified `total_hits === unique
   canonical LinkedIn URLs` (canonicalised: lowercase, strip query/trailing slash, collapse
   country-subdomain proxy hosts like `co.linkedin.com` to `linkedin.com`).
2. Independent buyer route (never touches BrightData): Apollo `mixed_people/api_search` by
   broad `person_seniorities` and `person_departments` against the company's domain — titles
   taken as Apollo observed them, not invented. Top 4-6 senior-pattern titles per company sent
   to Exa (`category: "people"`) as `"<title>" at "<Company>"`. Kept only rows whose structured
   `workHistory` shows a **current** (open-ended) role at that employer.
3. Leak = Exa-verified people whose canonical LinkedIn URL is absent from the drained roster,
   divided by all Exa-verified people.

## Drain provenance and verification

| Company | Source | total_hits | unique canonical | Match | Round-number flag |
|---|---|---|---|---|---|
| harbor-msp | fresh pull, this session | 206 | 206 | yes | no |
| ntiva-inc- | fresh pull, this session | 445 | 445 | yes | no |
| frsecure | reused `bd-aris.json` (prior verified pull) | 109 | 109 | yes | no |
| centre-technologies | reused `bd-aris.json` (prior verified pull) | 288 | 288 | yes | no |
| cyber-salus | reused `bd-aris.json` (prior verified pull) | 21 | 21 | yes | no |
| arqfinance | **no drain** — every fresh-pull attempt hung/failed at the TCP level during the account outage; no prior verified pull exists on disk | — | — | — | dropped |

Own fresh BrightData record volume this session: 206 + 445 = **651 records** ≈ **$1.63** at
$2.50 CPM (harbor-msp $0.52, ntiva-inc- $1.11). The frsecure/centre-technologies/cyber-salus
figures cost nothing further — they are read from an existing verified file, not re-pulled.
Total attributable to this task: **≈$1.63**, under the $3 ceiling.

## Leak rate — measured, 5 verified-clean companies

| Company | Exa-verified buyers | Leaked | Retained | Leak rate |
|---|---|---|---|---|
| harbor-msp | 15 | 1 | 14 | 6.7% |
| ntiva-inc- | 22 | 1 | 21 | 4.5% |
| frsecure | 21 | 2 | 19 | 9.5% |
| centre-technologies | 19 | 0 | 19 | 0% |
| cyber-salus | 7 | 0 | 7 | 0% |
| **Pooled (n=5)** | **84** | **4** | **80** | **4.8%** |

arqfinance excluded — no verified drain, so no leak figure is reported for it.

### Who leaked (all 4, across all verified companies)
- **Kevin Cook** — *Chief Strategy Officer*, ntiva-inc- (asked as CEO; his real current title
  is CSO). **The one senior miss**: a sitting C-suite executive entirely absent from a
  445-person roster that otherwise correctly holds the actual CEO, COO, CTO, CRO, and CCO.
- **Clint Cooper** — *POD CIO - Agriculture*, harbor-msp. Regional pod-level CIO, moderate
  seniority. Peers with the identical title pattern (Ryan Heiob, Heather Wightman) ARE in the
  roster, so this reads as one missing individual, not a title-class gap.
- **Patrick McCaffrey** — *Sales Manager*, frsecure (Exa surfaced him under a "Chief Revenue
  Officer" query, but his actual current title is a mid-level individual-contributor sales
  role). Low seniority, arguably not a real buyer.
- **April M.** — *Senior Information Security Consultant / vCISO*, frsecure. A billable
  consultant role, not internal leadership — the actual Executive Director she was queried
  against (Dave Tuckman) IS in the roster. Low-to-moderate seniority.

Net: of 4 leaks across 84 verified buyers, **1 is genuinely senior (C-suite)** and 3 are
mid/junior or arguably not buyers at all. The earlier n=2 read (1 of 2 leaks was C-suite)
overstated how often seniority leaks — at n=5 it's 1 of 4, and the two companies added from
the verified prior pull (centre-technologies, cyber-salus) leaked no one.

## Verdict against the reviewer's bar
Bar: any leak refutes "complete"; pooled leak >10% means BrightData cannot be the sole
denominator.

- **Per company**: 6.7%, 4.5%, 9.5%, 0%, 0% — all five sit **below** the 10% demotion line;
  frsecure is closest at 9.5%.
- **Pooled**: 4.8% (4/84) — **below** the 10% line, and it moved down, not up, as the sample
  grew from 2 to 5 companies drawn from two different pulls (fresh + prior).
- **On "who matters more than how many"**: one real C-suite miss survives scrutiny (Kevin
  Cook). That single case is still a legitimate demotion signal on its own — a roster that
  silently drops a sitting CSO while nailing the rest of the C-suite around him is a real,
  unpredictable hole, not noise. But it is one person in 84, not a pattern across the sample:
  two of five companies leaked nobody, and none of the four leaks that did occur skew toward a
  correlated title class.
- **Bottom line**: at n=5 (arqfinance excluded for lack of a verified drain), the number does
  not clear the demotion bar, and the qualitative check does not show a systematic senior-skew
  failure mode either — it shows one clean miss plus mostly-junior noise. This still argues for
  treating BrightData as the primary source with the roster spot-checked, not fully trusted as
  the sole ground truth, given a 20%-of-sample rate of at least one real senior miss.

## Cost
Own Exa spend: $0.238 (34 searches, banked under `leak:*` in `ledger.json`). Own BrightData
spend: ≈$1.63 for 651 fresh records (harbor-msp + ntiva-inc-); no further BrightData cost for
the three companies read from the existing verified `bd-aris.json` pull.

## Artifacts
- `leak-drain.mjs`, `leak-drain-summary.json`, `roster-harbor-msp.json`, `roster-ntiva-inc-.json`,
  `roster-frsecure.json`, `roster-centre-technologies.json`, `roster-cyber-salus.json`
- `leak-apollo.mjs`, `leak-apollo-results.json` (all 6 companies, Apollo side unaffected by the outage)
- `leak-exa.mjs`, `leak-exa-results.json` (all 6 companies)
- `leak-compute.mjs` — canonicalisation + leak math
