# Verified provider cookbook

Only call shapes OBSERVED WORKING in this session. Every entry has been run and returned
data. Where something is unverified it says so. Secrets live in
/Users/lahfir/Documents/Projects/Algominds/algo-backend/.env

Written because this session repeatedly declared a provider broken when the call was wrong:
BrightData "cannot verify titles" (wrong endpoint), Clay "too expensive" (wrong pricing
model), Clay 404 (guessed path), treg "402 is harmless" (billed $5.49).
RULE: never declare a provider incapable without the working call shape in this file.

---

## CLAY — strongest retrieval source measured. VERIFIED.

Base `https://api.clay.com/public/v0`   header `clay-api-key: $CLAY_API_KEY`
TWO STEPS. A single call does not work.

    POST /search/filters-mode
      { "source_type": "people",
        "filters": { "company_identifier": ["harborit.com"],
                     "job_title_seniority_levels_v2": ["c-suite"] } }
      -> { "search_id": "..." }

    POST /search/filters-mode/{search_id}/run
      { "limit": 500 }
      -> { "data": [...], "has_more": bool, "period_quota": {...},
           "exhaustion_reason": ... }
      Repeat with the same search_id while has_more is true.

Row fields: name, url (LinkedIn), latest_experience_title, latest_experience_company,
latest_experience_start_date, matched_experience, location.

FILTERS THAT WORK:
  company_identifier            domain OR LinkedIn company URL, array
  job_title_seniority_levels_v2 founder owner board-member partner c-suite vp director
                                head manager senior mid-level entry intern unknown
  job_title_keywords

CRITICAL — THE 499 CAP. One unfiltered query silently caps at ~499. PARTITION BY SENIORITY
BAND, one query per band, and union the distinct LinkedIn URLs.
  airwallex.com  unfiltered 499  |  union of seniority bands 1,773  |  union of country 1,637
DO NOT TRUST has_more:false. It is returned at the end of EVERY slice including partial
ones. It does not mean the index is exhausted.

The senior bands never approach the cap, so for buyer discovery the ceiling never binds:
  airwallex.com  founder 9 · owner 1 · board-member 7 · partner 10 · c-suite 14
                 vp 26 · head 71 · director 158   = 296 people in 8 calls

COST: NOT per-call dollars. Draws on a bundled ANNUAL RECORD QUOTA, 1,500,000/yr on this
workspace, resetting 2027-01-01. In-run quota delta is exactly 1:1 with rows returned.
The counter is NOT monotonic across runs (shared production key, other traffic moves it) --
attribute by IN-RUN DELTA, never by snapshot.
The earlier "6-20 credits per person" dismissal was WRONG: search does not touch the Data
Credits pool at all. Those credits are for enrichment routines.

QUALITY: 100% of rows carry a real current title and LinkedIn URL, at every size from 21 to
2,364 employees. 7 of 7 known seniors found at Harbor IT. No duplicate URLs, no junk rows.
WRONG DOMAIN BEHAVIOUR: harbormsp.com returns {"data":[],"has_more":false}. Clean empty,
no hallucination. Best failure behaviour of any provider tested.

---

## BRIGHTDATA — roster source. VERIFIED, but currently IP-BLOCKED.

Header `Authorization: Bearer $BRIGHTDATA_API_TOKEN`
Dataset `gd_l1viktl72bvl7bjuj0` = LinkedIn people profiles, 115,000,000 rows, ALREADY COLLECTED.

THERE ARE THREE ENDPOINTS AND ONLY ONE IS RIGHT.

  WRONG  POST /datasets/v3/trigger
         Scrapes a profile LIVE and LOGGED-OUT. position and experience come back null and
         fields show ****. THIS is what made this session wrongly conclude BrightData could
         not verify a job title. It is not a plan limit. It is the anonymous LinkedIn view.

  SLOW   POST /datasets/filter  -> {snapshot_id}, then
         GET /datasets/snapshot/{id}          status, cost, dataset_size
         GET /datasets/snapshot/{id}/download?format=json
         172 seconds for 206 rows. Queues under load and can stall 25+ minutes.

  RIGHT  POST /datasets/search/gd_l1viktl72bvl7bjuj0
         { "size": 100, "sort": "default",
           "filter": {"name":"current_company_company_id","operator":"=","value":"harbor-msp"} }
         -> { hits: [...], total_hits: 206, took: 209, search_after: <cursor> }
         3.4 seconds for the same 206 rows. size CAPS AT 100 on this dataset whatever the
         docs say. Page with search_after. sort:"default" is required to get a cursor.

  GET /datasets/list                                    lists 1755 datasets. WORKS.
  GET /datasets/{id}/metadata                           46 fields + operators. WORKS.
  /datasets/v3/list  and  /customer/balance             DO NOT WORK (404 / 403).

COMPOUND FILTER, verified EXACT against a local roster:
  {"operator":"and","filters":[
    {"name":"current_company_company_id","operator":"=","value":"harbor-msp"},
    {"name":"position","operator":"includes","value":"Director"}]}
  Director 14 vs 14, Chief 3 vs 3, VP 1 vs 1, President 2 vs 2, Owner 0 vs 0.

NESTED FILTERING IS IMPOSSIBLE. experience.company_id and every dotted path return
`unsupported filters: experience.company_id`. Only current_company_company_id,
current_company_name and position are queryable.

`position` IS THE HEADLINE, NOT THE TITLE. They agree only 44% of the time. Do not use it to
find people by title: "Chief Executive Officer" appears as "CEO", "Director of Service
Delivery" appears as "--", "Director of Finance" appears as "Financial Professional".

READING THE TITLE — experience[] has TWO SHAPES and getting this wrong loses most people:
  Form A  company_id set, end_date is the STRING "Present", title = THE JOB, positions[] empty
  Form B  company_id set, end_date null, title = THE COMPANY NAME, positions[] holds the
          real titles each with its own end_date
  "Present" is the current marker. null is NOT. Working extractor: bd.mjs currentTitleAt().

COST $2.50 CPM = per 1,000 records RETURNED, both endpoints. Zero-record queries are free.
The snapshot `cost` field reads 0 and is NOT reliable. Effective cost per USABLE person is
2.7-3.9x sticker because ~29% of billed rows are junk.

FAILURE BEHAVIOUR: no 429, no Retry-After, no status code. Under sustained load it IP-BLOCKS
-- TCP connect never completes, ICMP 100% loss, unauthenticated endpoints dead too. Twelve
agents on one account triggered it and it did not lift in 25+ minutes.
SERIALISE STRICTLY. Treat a timeout as UNKNOWN, never as an empty result.

---

## EXA — title accuracy and first-party verification. VERIFIED.

Header `x-api-key: $EXA_API_KEY`.  POST https://api.exa.ai/search

PEOPLE SEARCH:
  { "query":"<titles> at \"<Company>\"", "category":"people", "type":"fast", "numResults":10 }
  Returns entities[].properties with a STRUCTURED workHistory carrying dates.
  A current role is dates.to === null.
  REJECTS startPublishedDate, endPublishedDate, includeDomains, excludeDomains.

FIRST-PARTY VERIFICATION — the ONLY LinkedIn-independent evidence we have:
  { "query":"<name> <title>", "includeDomains":["harborit.com"], "numResults":3,
    "type":"fast", "contents":{"text":{"maxCharacters":2000}} }
  includeDomains constrains WHICH PAGES the evidence may come from. It does NOT filter
  employment. That distinction was got wrong before.

COST: read costDollars.total from the response. ~$0.007/search. type:"auto" returns the SAME
people as "fast" at the same price but 3.4-4.6x slower. Always use "fast".

---

## APOLLO — free title/seniority grounding. VERIFIED.

Header `x-api-key: $APOLLO_API_KEY`
POST https://api.apollo.io/api/v1/mixed_people/api_search
  { "q_organization_domains_list":["harborit.com"],
    "person_seniorities":["owner","founder","c_suite","vp","head","director"],
    "person_departments":[...], "per_page":10 }

GOTCHA: total_entries is TOP-LEVEL, not under pagination.
Returns last_name_obfuscated and NO LinkedIn URL.
Query by SENIORITY and DEPARTMENT, never by named titles -- searching named titles reproduces
the title-invention failure. Only 25-27% of model-planned titles exist at a typical company.
Freshness is good: 156 of 167 records refreshed within 30 days.

---

## TREG — credential broker. CATALOG USEFUL, CALLS HAZARDOUS.

Header `X-Treg-Token: $TREG_API_KEY`.  Base https://treg.to
  GET  /catalog/platforms/*        FREE, never moves the balance. Use this.
  POST /call/<endpoint.id>?params  METERED.

DANGER, MEASURED TWICE: lusha.x.decision-makers is labelled type "free" and bills $5.4912
per call, UNCAPPED. A ZERO BALANCE IS NOT A SPENDING GUARD -- it billed anyway. Total
overspend this session $6.4962 against a $1.00 grant.

PRE-CALL SAFETY RULE. Of 344 endpoints across people/companies/linkedin, 252 carry
source_url + confidence and 92 do not. The 29 labelled "free" WITHOUT those fields and
without an empirical zero-cost note are the distrust list:
  lusha.x.decision-makers, apollo.people.search, coresignal.people.search,
  hunter.x.multi-domain-search, hunter.x.discover-people, crustdata.people.autocomplete,
  crustdata.companies.identify, findymail.intellimatch.*, findymail.signals
Confirm real cost with GET /calls/{id} after ONE deliberate test before ever repeating.
Prefer routed treg.* endpoints -- they carry X-Treg-Route-Max-Cost. Raw provider ids do not.

Correctly-priced: aviato.companies.employees $0.005 (<=100 rows, the only roster endpoint,
but its one test matched the WRONG company and returned title "Firma"),
hunter.people.enrich $0.0049, tomba.people.enrich $0.0089, exa.people.search $0.0070
(identical to our direct price, no discount).

UNVERIFIED but potentially the real value: llms.txt states an org's OWN registered key always
beats treg's and those calls are NEVER metered, and `treg upload env` auto-registers keys
from .env. That would make treg a zero-marginal-cost integration layer. NOT TESTED LIVE.

---

## NOT APPLICABLE
Nango, Composio — auth/integration infrastructure, not contact-data providers. They manage
OAuth connections to SaaS apps. They cannot find a person.

## UNTESTED
Findymail — VERIFIED: does title-search. 5 people at Harbor IT / 5 at Ntiva, 1 unique find
total (Ntiva CFO). SLOW: 27-50s per call, one 504 observed. Cost not exposed by the API,
~10 credits per call. NOT worth including: worst cost per marginal buyer of any source.
search or only email lookup.

---

## KNOWN DATA BUGS IN OUR OWN STORE

companies-export.json stores harbormsp.com for Harbor IT. The correct domain is
harborit.com. Every Apollo query in this project ran against the wrong domain and returned
zero, which was wrongly read as an Apollo limitation. ALWAYS verify a stored domain before
concluding a provider has no coverage.

The stored LinkedIn slugs are also unvalidated: kraken-exchange returns 0 rows, and
evergreen-holding-company returns 104 unrelated real people.
