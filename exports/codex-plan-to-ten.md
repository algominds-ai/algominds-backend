**The shortest credible path is: fix the documents, make the eval count accepted output, remove artificial stopping, then recover only demonstrable provider misses.** No implementation can guarantee 500 qualified companies in a market containing 80; “10/10” must mean filling feasible requests and accurately reporting the remainder.

I read CLAUDE.md, CONCEPTS.md, all 23 solution documents, the complete [ledger](/Users/lahfir/.claude/jobs/24a9762f/tmp/ledger.md), current code and exports. HEAD observed: `fca6abc`; some people review fixes described as underway in the ledger are not present there. Nothing changed.

**EVAL — prerequisite, before comparing another arm**

1. **Make the existing score measure the owner’s objective.**  
   **Files/functions:** eval branch `eval/headline.ts::{computeVerdict,recordBoundsHold}`, `people-headline.ts::computePeopleVerdict`, `people-run.ts::fetchRunPeople`, `people-live.ts::main`.

   Rank **distinct accepted output**, accepted/dollar, accepted/minute and companies with an accepted buyer divided by **all requested companies**; unresolved and unsearched companies remain in that denominator. Unknown labels earn nothing and block promotion; replace `recordBoundsHold`—currently just “domain nonempty and name present”—with actual bounds checks, and score immutable run evidence rather than whichever person currently belongs to its company.

   **Why first:** the current scorer rewards stored/verified counts, permits unlabelled output through its correctness gate, and cannot establish market recall. The [exports](/Users/lahfir/Documents/Projects/Algominds/algo-backend/exports/summary.csv) combine arms, and `people-live` recreates its database; preserve the company arm and use a separate people arm.

   **Proof:** `score-truth`, replay tonight’s saved runs without vendor calls; recover exactly 33 accepted Ondato companies, 29 distinct Mstone companies, and 15 accepted Ondato buyers. Independently inspect uncovered companies and a sample of refusals, using source pages rather than `fitReason`; this follows [judging-candidates.md](docs/solutions/judging-candidates.md). **Expected effect:** honest numbers, not extra leads. **Risk:** some apparent wins disappear.

**PROFILE DOCUMENTS — highest return per line**

2. **Replace ambiguous buyer exceptions and contradictory eligibility wording.**  
   **Files:** eval seeds `ondato.json`, `form3.json` and corresponding stored profile documents; `src/core/onboard.ts` only to preserve the agreed wording.

   Ondato: **“Prefer the person accountable for signup conversion. Founder/CEO alone qualifies only when the roster has no dedicated growth, product or marketing owner; a founder explicitly holding that operating responsibility remains eligible. Company size is context, not a cutoff.”** Form3: explicitly distinguish accountable platform/security owners from directors who merely influence evaluation, customer-trust/governance roles and general operations executives; spell out buyer geography separately.

   Keep the financial OR band and selective strictness. Resolve Form3’s actual acceptance contract before changing its judge: its description still says “10,000+”, the requirement caps at 10,000, and GoCardless’s exported rejection references missing certificate evidence while the hard page requirement asks for production Kubernetes.

   **Provider leverage:** Clay already supplies the roster needed for relative ownership selection; [people-method.md](docs/solutions/people-method.md) measured 47%→95% precision by changing buyer input alone.  
   **Expected effect:** target removal of six Ondato false buyers while retaining all 15 accepted buyers—initially **15/16**, with the duplicate still outstanding; Form3’s five buyer refusals are the next target, not an automatic five recoveries.  
   **Proof:** `rubric-owner`, fixed Ondato 33-company and Form3 10-company inputs, three paired trials; then Mstone unchanged. **Risk:** incomplete rosters can make a founder look like the only owner; do not relabel rejected output merely to make this arm win.

**ENGINE — implement in this order**

3. **Deliver coverage before spending on the tenth buyer at an already-covered company.**  
   **Files/functions:** `find-people-verify.ts::runBuyerMode`, `find-people-company.ts::runCompanies`, `find-people.ts::clampCompanies`, request schemas and payloads.

   Have the existing selector order candidates by ownership strength; verify until the company has one accepted verification outcome, then defer remaining picks until every requested company has had its first pass. Preserve pending work across bounded continuations and expose the requested spend limit and unfinished domains; the current cap is already **100**, while the **$2 budget** still stops batches.

   **Provider leverage:** cheap Clay rosters plus bounded minimal-effort verification, as measured in [people-method.md](docs/solutions/people-method.md); keep paid calls durable per [agent-run-polling.md](docs/solutions/agent-run-polling.md).  
   **Expected effect:** Mstone attempts **30/30 instead of 20/30**, Form3 **29/29 instead of 10/29**; more covered companies at comparable spend, potentially fewer total buyers until the second pass.  
   **Proof:** `coverage-first`, those exact lists and budgets, then 100 companies; compare accepted coverage and total accepted buyers separately. **Risk:** “verified” still needs the rubric/evidence fixes; ordering by itself cannot create accepted buyers.

4. **Deduplicate identities before they consume request slots or verification spend.**  
   **Files/functions:** `companies/round.ts::judgeSlices`, `companies/judge.ts::decideRows`, `find-companies.ts::runOneRound`, `people/select.ts::resolvePicks`.

   Carry accepted organisation identities across judge batches and rounds; collapse equal domain-validated Exa IDs directly, and let the existing semantic judge resolve remaining brand aliases against prior accepted organisations. Count only retained representatives toward fulfilment and deduplicate selected candidate IDs before verification; resolve different LinkedIn URLs as the same person only with supporting identity evidence.

   **Provider leverage:** Exa’s organisation identifiers and their limitations are documented in [exa-search-contract.md](docs/solutions/exa-search-contract.md); retain the direct dedupe read described in [dedupe-read-cache-consistency.md](docs/solutions/dedupe-read-cache-consistency.md).  
   **Expected effect:** Mstone’s duplicate stops occupying slot 30; Ondato’s duplicate buyer stops inflating delivery. **Proof:** `identity-slots`, Mstone 50 across multiple rounds plus its known brand pair; Ondato people 33. **Risk:** parent ownership is not necessarily one buying organisation; never collapse by similar name alone.

5. **Continue productive discovery; stop repeating an exhausted retrieval strategy.**  
   **Files/functions:** `find-companies.ts::runFindCompaniesRounds`, `companies/index.ts::runRounds`, `companies/round.ts::runRound`, `synthesize.ts::synthesize`.

   Keep one workflow-owned loop and carry its actual yield/proving feedback forward; stop on fulfilment, explicit budget or repeated absence of new eligible candidates—not merely round three. Continue distinct profile-derived search angles while productive, then use the existing low-effort agent route for a bounded shortfall attempt; preserve filters and proving unchanged, and handle 500 as bounded durable chunks rather than one giant step.

   **Provider leverage:** company search returns at most 100 records, identical queries repeat results, and agent yield comes from distinct angles rather than a larger count request: [exa-search-contract.md](docs/solutions/exa-search-contract.md).  
   **Expected effect:** the only direct route from Ondato **33 toward 50**; the gain is unknown until measured—three rounds did not prove the whole market exhausted.  
   **Proof:** separate `continue-search` and `shortfall-agent` arms, Ondato 50, then 100 on Ondato/Mstone/Form3 and finally a 500-company broad-profile campaign. **Risk:** diminishing returns; require the added accepted companies to justify marginal dollars/minutes, and never buy website resolution for every website-less entity.

6. **Make existing evidence usable and acceptance complete.**  
   **Files/functions:** `companies/judge.ts::{judgeSlice,keepsRow}`, `companies/proof.ts::postProvingSearch`, `companies/proving.ts::proveAndJudge`, `people/verify.ts::profileOpinion`, `find-people-second-opinion.ts::profileRescue`, `providers/exa/contents.ts::parseResponse`.

   A missing/malformed judge response must remain unjudged, distinct from a valid verdict saying a non-strict requirement is unproven; retry only the missing work. Give the existing judge the returned proof text and date, verify quoted text locally, retain decisive homepage/profile evidence, and carry the verified current role into buyer assessment and storage.

   Capture the actual malformed contents response before changing its schema; keep homepage fail-soft and accept only individually validated results. **Do not guess which field is optional.**

   **Provider leverage:** search supplies text/highlights and contents supplies per-URL outcomes; [companies-round-proof.md](docs/solutions/companies-round-proof.md), [exa-agent-output-schema.md](docs/solutions/exa-agent-output-schema.md) and [people-method.md](docs/solutions/people-method.md).  
   **Expected effect:** closes false-acceptance paths and recovers usable evidence; no defensible numerical yield forecast yet. **Proof:** separate `complete-verdict`, `proof-input` and `current-role` arms; Form3/Carta 30, Ondato people 33, with missing-verdict, departed-person and wrong-employer controls. **Risk:** stricter evidence handling can lower recall; preserve bounded rescue and measure accepted losses explicitly.

7. **Use one targeted open-web fallback only for companies still without a buyer.**  
   **Files/functions:** `find-people-rescue.ts::fallbackRoster`, `providers/exa/people-roster.ts::exaPeopleRoster`, `find-people-verify.ts::runBuyerMode`.

   Replace the fallback’s hardcoded senior-title query with the existing buyer rubric and inspect **all** current employment entries for the target organisation. If Clay plus org-matched Exa still yields no accepted buyer, allow one minimal-effort Exa agent retrieval asking for that company’s actual operating buyer and LinkedIn URL, then feed candidates through existing selection and verification.

   **Provider leverage:** the agent found real people absent from the index, but broad planner fan-out added almost no recall; [people-method.md](docs/solutions/people-method.md).  
   **Expected effect:** incremental coverage among Ondato’s 16 empty companies, not a promise of 16 recoveries. **Proof:** `empty-company-agent`, those 16 plus uncovered small Aris firms; keep only if it adds independently accepted coverage at acceptable marginal cost. **Risk:** expensive duplicates and namesakes; target domain is mandatory, and one unsuccessful bounded attempt ends the search.

**The small latency cut belongs alongside these, not in a new architecture:** in `judge.ts`, request an empty reason for accepted rows while preserving requirement statuses; remove unused `pageQuery` generation if it remains unused. Probe `short-output` on Ondato 50 and Form3 30: [judging-candidates.md](docs/solutions/judging-candidates.md) already demonstrates the cost of output tokens. Do not switch models again; the larger saving comes from avoiding repeated rounds.

**What not to build:** another planner, provider registry, confidence framework, title regex, blanket strictness, arbitrary headcount cutoff, blanket larger judge batches, recursive fallback research, Braintrust replacement, or shared in-memory Workers rate limiter. Do not restore GetLeads until credits exist, and do not add Apollo retrieval on the strength of obfuscated names. Keep vendor pacing, retries, append-only evidence, direct dedupe reads, synthesizer cache bypass and bundle stubs.

| Tranche, after successful paired proof | Expected companies | Expected people |
|---|---:|---:|
| Honest eval + agreed documents | 7.5–8 | 7–7.5 |
| Coverage scheduling + identity dedupe | 8–8.5 | 8–8.5 |
| Productive continuation + trustworthy evidence + bounded recovery | 9–9.5 | 9–9.5 |
| Repeated full-chain proof across all seven profiles, feasible 100/500 requests, zero adjudicated wrong rows | **10 on that demonstrated scope** | **10 on that demonstrated scope** |

Use one change per arm, frozen documents/keys, three paired trials and centrally scheduled live traffic; run the combined winner on a second day. **The ledger supports this ordering. It does not support promising that any untested patch reaches 10.**
