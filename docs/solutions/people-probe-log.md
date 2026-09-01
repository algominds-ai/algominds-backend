# find-people: what must be documented

Running notes. Append, do not rewrite. Every number here is MEASURED.
Status key: PROVEN / PROVISIONAL / OPEN / BLOCKED

---

## 1. Bugs in the shipped repo. Fix regardless of what we build.

PROVEN  `toPersonEntity()` src/core/people/candidates.ts:102 takes the FIRST current role,
        while employment verification can match a DIFFERENT current role. It can save the
        title from company A while verifying employment at company B. Found by codex.

PROVEN  The 90-day company skip in src/core/db/known-people.ts:42 treats a company as
        resolved once ANY person is found. That is wrong if the roster is the point.

PROVEN  Company slugs stored by find-companies are not validated.
          kraken-exchange   -> 0 rows. Company is not empty, the slug is wrong.
          evergreen-holding-company -> 104 rows of UNRELATED people (a Brazilian production
          assistant, students, a cleaner) all rendering as "Evergreen". Response looks normal.
        Nothing in the API signals either case.

PROVEN  ROOT CAUSE of the precision ceiling. decisionMakerTitles() in
        src/core/people/index.ts:130 plans 3-6 titles from the ICP BEFORE any retrieval, and
        resolvePlan() freezes them. Measured against Apollo: only 25-27% of planned titles
        exist at a typical company, and half existed at NONE of 10 companies. Exa is then
        asked for titles nobody holds and returns its nearest guess. That padding IS the
        ceiling. This is the one piece that must change first.

---

## 2. The method

PROVEN  The two sources fail on DIFFERENT people.
                              Harbor IT (206 emp)   Ntiva (445 emp)
          Exa alone                    13                  12
          BrightData alone             11                  19
          UNION                        20                  28
          overlap                       4                   3
        Cost $0.028-0.041 per buyer. Overlap is tiny, so the union nearly doubles yield.
        -> generalisation to 10 companies is running (B-ondato-roster)
        -> extension to Apollo/Findymail/leadership-page is running (K-union-bakeoff)

PROVEN  WHY they are complementary. Of 25 Exa-found buyers, 22 were present in the
        BrightData roster (88%) but only 7 had a readable structured title.
        BrightData knows WHO works there. Exa knows WHAT they do.

PROVEN  Buyer leak rate, independent route (Apollo by seniority -> Exa, never touching
        BrightData), n=5 companies: 4/84 = 4.8% pooled. Per company 6.7 / 4.5 / 9.5 / 0 / 0.
        Below the 10% demotion bar, but NONZERO, so never say "complete".
        1 of the 4 leaked is a sitting C-suite (Ntiva's Chief Strategy Officer).

PROVEN  The count is emergent, which was the requirement.
          206 employees -> 20 buyers.  445 -> 28.  21-person company -> a handful.
        Nothing is padded to a target.

---

## 3. Provider facts worth a docs/solutions entry

PROVEN  BrightData has TWO dataset endpoints and we used the wrong one for hours.
          /datasets/v3/trigger  scrapes a profile LIVE and LOGGED-OUT -> position and
                                experience null, fields masked ****. This is what made us
                                wrongly conclude BrightData could not verify a title.
          /datasets/filter      snapshot, queues, 172s for 206 rows, can stall 25+ min
          /datasets/search/{id} REAL-TIME, 3.4s for the same 206 rows, returns total_hits
                                free, pages via search_after. USE THIS ONE.
        size caps at 100 per call on this dataset whatever the docs say.

PROVEN  Price is $2.50 CPM = per 1,000 records RETURNED, both endpoints. Zero-record
        queries are free. The snapshot `cost` field reads 0 and is NOT reliable; the
        balance endpoint 403s so we could not reconcile it. Cost at the published rate.
        Effective cost per USABLE person is 2.7-3.9x the sticker, because ~29% of billed
        rows are junk.

PROVEN  The experience[] array has TWO shapes and getting this wrong silently loses people.
          Form A: company_id set, end_date is the STRING "Present", title = the JOB
          Form B: end_date null, title = the COMPANY NAME, positions[] holds the real titles
        "Present" is the current marker. null is NOT. I had it backwards for an hour.

PROVEN  Nested filtering is impossible. experience.company_id and every dotted path return
        `unsupported filters: experience.company_id`. Only current_company_company_id,
        current_company_name and position are queryable.

PROVEN  position is the HEADLINE, not the title, and they agree only 44% of the time.
        Server-side title filtering is EXACT when it returns (Director 14 vs 14, Chief 3 vs
        3, VP 1 vs 1, President 2 vs 2, Owner 0 vs 0) but searches the wrong field:
          Chief Executive Officer -> headline says "CEO"
          Director of Service Delivery -> headline is literally "--"
          Director of Finance -> headline says "Financial Professional"
        14 model-proposed terms matched 5 of 27 buyers = 19%. PROBE-ONLY IS DEAD. Drain.

PROVEN  BrightData does not rate-limit gracefully. Under sustained load it gives no 429, no
        Retry-After, no status code. It IP-BLOCKS: TCP connect never completes, ICMP 100%
        loss, unauthenticated endpoints dead too. 12 agents on one account triggered it and
        it did not lift in 25+ minutes.
        PRODUCTION RULE: serialise strictly, set an explicit client timeout, treat a timeout
        as UNKNOWN and retryable, NEVER as an empty result. There are now THREE ways to get
        a plausible-looking empty answer: wrong slug, wrong-identity slug, and a quota hang.

PROVEN  Freshness is good. Undocumented per-row `timestamp` skews fresh, median 2 days,
        90% under 7 days. 20 of 20 people BrightData called current were verified still
        employed via Exa. Caveat: only covers the ~26-34% of rows with a usable title.

PROVEN  Masking bias is a NULL result, well powered. Across 1,527 rows in 10 companies,
        senior share among structured rows 8.6% vs masked rows 9.3%. Direction flips by
        company. The feared "senior people are masked more" does not exist.

PROVEN  Identity traps are rare, not systemic. Only 1 of 10 companies (Harbor IT, 10.7%,
        Harbor Networks + Boston Wireless) shows sibling-brand contamination. Tied to that
        company's acquisition history. slugsSeen() finds the sibling slugs from the data.

PROVEN  treg: catalog price labels are NOT trustworthy. lusha.x.decision-makers is labelled
        type "free" and billed $5.49 on one call, draining a $1.00 grant instantly. Raw
        provider ids carry NO cost ceiling; routed treg.* endpoints carry
        X-Treg-Route-Max-Cost. Correctly-priced endpoints carry source_url and confidence
        fields; that one carried neither -- a possible pre-call safety check, under test.
        Data quality when it arrived was GOOD: 44 people at Harbor with real titles, no
        masking, 3 of 4 known seniors.

PROVEN  Apollo gotcha: total_entries is TOP-LEVEL, not under pagination.

PROVEN  Exa: includeDomains filters RESULT PAGE HOSTS, not employment. type:"auto" returns
        the same people as "fast" at the same price but 3.4-4.6x slower. Use "fast".

NOTE    Nango and Composio are auth/integration infrastructure, not contact-data providers.
        They cannot find people. Not applicable here.

---

## 4. The measurement itself is suspect

PROVISIONAL  The judge every quality number rests on asks "could this person plausibly buy?"
        It is generous by construction and scores only what was RETURNED, so a method that
        omits the best buyer keeps a perfect score. codex demolished it correctly.
        Harder judge preliminary on Exa numResults=5:
          precision@2 0.90 (CI 0.75-1.00), stale-control rejection 0.90, challenger win 0.00
          hard-negative FPR 0.22  <- the judge picks a WRONG-FUNCTION person as a top-2
                                     buyer about 1 time in 5
        If that holds, every quality figure in this project inherits the error.
        -> H-hard-judge is re-scoring all three existing methods under controls

---

## 5. Open / blocked

OPEN     Does the union keep growing with a 3rd and 4th source? (K-union-bakeoff)
OPEN     Clay: retrieval, verification, enrichment, or nothing? Never properly tested.
OPEN     treg funded now: marginal contribution across 3 differently-sourced endpoints,
         and whether it carries a LinkedIn roster source that bypasses our IP block.
OPEN     Held-out generalisation on Form3, now running WITHOUT BrightData (Apollo -> Exa).
BLOCKED  Ondato compliance-vs-growth counts. Needs BrightData, which is IP-blocked.
BLOCKED  The correct Evergreen slug. Needs BrightData.
OPEN     The Ondato buyer gap. Same 100 people scored 74% against the profile as written
         and 1% against the client's stated growth-side intent. The stored profile says
         "compliance" 6 times and "conversion"/"drop-off"/"pass rate" zero times.
         This is a PROFILE bug fixable at onboarding, not a retrieval bug.

---

## 6. APPENDED 19:52 — Clay overturns the architecture

PROVEN  Clay is a RETRIEVAL source, not enrichment-only. It was dismissed twice in this
        project on price alone, both times from a planning document, never from a live call.
        Both dismissals were wrong. Mine was one of them.

          POST /search/filters-mode  filters={company_identifier:["harborit.com"],
                                     job_title_seniority_levels_v2:[...]}   then POST .../run
        Each result carries name, LinkedIn url, latest_experience_title,
        latest_experience_company, matched_experience, location. All server-computed.

PROVEN  Harbor IT benchmark against our 206-row ground truth:
          source       people   real current title   known seniors found
          Clay          212           100%                 7 of 7
          BrightData    206           ~30%                 -
          Lusha          44           100%                 3 of 4
          Exa            13-14        correct              -
          Apollo         -            25-27% of planned titles exist

PROVEN  Clay search does NOT draw on the "Data Credits" pool the earlier dismissal priced at
        6-20 credits/person. It draws on a bundled ANNUAL RECORD QUOTA: 1,500,000/year on
        this workspace, resetting 2027-01-01. Two searches moved `used` by exactly 212 then
        11. Measured marginal cost $0.00. That means "already paid for", NOT free -- the
        standalone dollar price is on Clay's billing page, not exposed by the API. OPEN.

OPEN    If Clay is not blind -- full roster AND correct titles in one call -- the union
        thesis may collapse to "just use Clay". The decisive number is now the MARGINAL
        CONTRIBUTION OF EVERY OTHER SOURCE GIVEN CLAY. A clean negative that reduces the
        architecture to one provider is a better outcome than a union we do not need.
        -> K-union-bakeoff re-ordered Clay-first
        -> J-clay testing a different vertical, scale, emergent count, and failure modes

PROVEN  The union generalises, but only above a size threshold. 9 Aris companies, 1,423 BD
        rows, one shared auditable buyer regex applied cold to both sides:
          Exa buyers 65, BD buyers 53, overlap 19, UNION 99, $3.94 = $0.040/buyer
        Presence/title split pooled: of 65 Exa buyers, 59 (90.8%) are somewhere in the BD
        roster but only 19 of those (32.2%) have a BD-readable title, and 6 (9.2%) are truly
        absent. That reproduces the 2-company pilot's 88%/32% almost exactly. MECHANISM
        CONFIRMED GENERAL.
        WHERE IT BREAKS: above ~100 employees the union beats the best single source by
        23-110%. Below ~50 it collapses to redundancy (Cyber Salus 21 emp and CyberlinkASP
        52 emp: union == Exa alone). eTrepid (10 emp) inverts: BD found zero buyers and half
        of Exa's buyers are not in BD's 10-row roster at all.

NOTE    Harbor's BD buyer count moved 11 -> 7 after currentTitleAt was fixed. That is the
        corrected number, not drift. The pilot's 20-person union used the buggy extractor.

---

## 7. APPENDED 19:56 — treg, and a real overspend I caused

INCIDENT  $6.4962 of real money spent against a $1.00 grant. Two calls to
          lusha.x.decision-makers billed $5.4912 EACH TIME, uncapped, confirmed by
          GET /calls and GET /orgs/4332/usage.
          CAUSE, mine: my brief to the agent asserted "a metered call at zero balance will
          402 harmlessly". I asserted that without verifying it. I had ALSO told the agent
          the balance was topped up. It acted on two contradictory statements from me and
          the unverified one was the dangerous one. Not the agent's error.
          RULE: never state a safety property of a paid API that has not been observed.
          A zero balance is NOT a spending guard.

PROVEN  treg catalog price labels cannot be trusted. lusha.x.decision-makers is labelled
        type "free" and really costs ~$0.125/contact. Raw provider ids carry NO cost
        ceiling; only routed treg.* endpoints carry X-Treg-Route-Max-Cost.

PROVEN  PRE-CALL SAFETY RULE, and this is the reusable part. Of 344 endpoints across
        people/companies/linkedin, 252 carry source_url + confidence and 92 do not. Of the
        58 labelled "free" WITHOUT those fields, 29 also lack any empirical zero-cost note.
        That worst bucket is the distrust list: lusha.x.decision-makers,
        apollo.people.search, coresignal.people.search, hunter.x.multi-domain-search,
        hunter.x.discover-people, crustdata.people.autocomplete, crustdata.companies.identify,
        findymail.intellimatch.*, findymail.signals.
        Never call an endpoint from that bucket without confirming cost via GET /calls/{id}
        after a single deliberate test.

PROVEN  Catalog prices for the correctly-labelled endpoints:
          aviato.companies.employees  $0.005/call, <=100 rows  (only roster endpoint)
          hunter.people.enrich        $0.0049/success
          tomba.people.enrich         $0.0089
          exa.people.search           $0.0070  -- SAME as our direct Exa price, no discount
          tikhub linkedin profile     $0.0010
          brightdata linkedin profile $0.0015
        A funded 10-company run on correctly-priced endpoints only: ~$0.59.
        BUT the one aviato test matched the WRONG company and returned a garbage title
        ("Firma"), so its title quality is unverified and the $0.59 is not yet meaningful.

UNVERIFIED  Own-key routing may be treg's real value here. llms.txt says a team's own
        registered credential always beats treg's and those calls are NEVER metered, and
        `treg upload env` auto-registers matching keys from .env. That would make treg a
        zero-marginal-cost integration layer over providers we already pay for, rather than
        a data vendor. Documented from the docs only. NOT tested live, deliberately.

VERDICT treg is weak as a DATA source given Clay: its best roster endpoint matched the wrong
        company, and exa.people.search costs exactly what we already pay. Its possible value
        is the integration layer, which is untested. Its catalog price labels are a hazard.

---

## 8. APPENDED 19:59 — Clay generalises. One open ceiling.

PROVEN  Title coverage holds at ~100% across every scale and vertical tested.
          company          BD headcount   Clay found   recall   title cov   c-suite
          cybersalus.com          21           19        90%      100%         3
          arqfinance.com           ?          166         -        99%         4
          harborit.com           206          212       103%      100%        11
          polymarket.com           ?          380         -       100%        11
          ramp.com             2,165          498        23%      100%         8
          airwallex.com        2,364          499        21%      100%        14
          discord.com          1,752          998        57%      100%        13

PROVEN  EMERGENT COUNT, the user's core requirement, met for the first time by any source.
        c-suite count tracks each org's real structure, not a fixed number or fraction:
        3 of 21 at Cyber Salus (14% of the org) vs 14 of 499 at Airwallex (2.8%).

PROVEN  Cost is not a constraint. In-run quota deltas are exactly 1:1 with rows returned.
        The whole probe drew 3,336 records = 0.22% of the 1,500,000/year pool. At the
        c-suite rate (~9 records/company) the pool covers ~166,000 companies/year; at the
        full-roster rate (~396/company) ~3,800 companies/year.
        WARNING: the quota counter is NOT monotonic across runs -- it is a shared production
        key and other traffic moves it. Attribute cost by IN-RUN DELTA, never by snapshot.

PROVEN  Clay fails HONESTLY, the only provider tested that does. Given harbormsp.com -- the
        WRONG domain actually stored for Harbor IT in our database -- it returned
        {"data":[],"has_more":false}. Clean empty, no hallucination, no confidently wrong
        people. Contrast BrightData, where the wrong Evergreen slug returned 104 unrelated
        real humans that looked entirely normal.

PROVEN  No duplicate LinkedIn URLs among Harbor's 212, no junk or placeholder rows, two
        harmless same-name collisions with different URLs. Spot-check of 10 against
        BrightData end_date and on-disk Exa workHistory: 8 corroborated current, 1
        corroborated by Exa only (Chief Customer Officer, MISSING from BD's 206), 1
        unverifiable, ZERO stale.

DISPUTED  The agent reports the large-company ceiling as genuine index exhaustion. I do not
        accept it yet. The counts are 499, 498 and 998 -- one under 500, two under 500, two
        under 1000. This project already adopted the rule that a result landing on a round
        number is a truncation signal. Everything small is complete (19/21, 212/206) and
        everything large stops just under a round number. has_more:false does not
        distinguish "index exhausted" from "query ceiling reached".
        TEST RUNNING: partition one company into disjoint slices by seniority, department
        and location, then count DISTINCT LinkedIn URLs. Union clearly over 500 means the
        cap is per query and Clay covers every company size alone. Union still near 499
        with heavy slice overlap means the ceiling is real and we need a fill-in source
        above ~1,000 employees.
        THIS DECIDES THE ARCHITECTURE: one provider, or a hybrid.

---

## 9. APPENDED 20:01 — the Clay ceiling is a per-query cap. RESOLVED.

PROVEN  The disputed ceiling in section 8 was a PER-QUERY CAP, not index exhaustion.
        Measured on airwallex.com:
          single unfiltered query            499
          union of seniority slices        1,773   distinct LinkedIn URLs
          union of country slices          1,637   distinct LinkedIn URLs
        BrightData's headcount for the same company is 2,364, so partitioning lifts recall
        from 21% to about 75%.

PROVEN  has_more:false IS MEANINGLESS as an exhaustion signal. It was returned at the end of
        EVERY slice, including slices that were plainly partial. Never read it as "the index
        is exhausted". This is why the first reading of the ceiling was wrong.

PROVEN  THE SENIOR BANDS DO NOT HIT THE CAP, so the ceiling never binds for buyer discovery.
        airwallex.com by seniority:
          founder 9 · owner 1 · board-member 7 · partner 10 · c-suite 14
          vp 26 · head 71 · director 158
          (manager 329, senior 486, mid-level 441, entry 19, intern 3, unknown 304)
        296 senior people at a 2,364-person company in 8 calls, none near 499.

=> PRODUCTION QUERY SHAPE: partition by seniority band and take the bands the profile needs.
   Complete, cheap, no truncation risk, and it costs ~296 quota records instead of ~2,364.

=> ARCHITECTURE: Clay alone covers every company size tested, 21 to 2,364 employees. The
   hybrid fill-in source proposed for large companies is NOT needed.
   Still open: does any other source find a correct buyer Clay missed? (K-union-bakeoff)

---

## 10. THE GOAL, restated 20:03 after user correction

The deliverable is a METHODOLOGY -- a harness that uses the providers we have, each at the
stage it is strongest, to find the RIGHT people at SCALE without errors.
It is NOT a contest to pick the best provider. Every provider has a strong suit and a blind
spot. The measurements exist to assign providers to stages, not to crown one.

FOUR STAGES, each with the failure it exists to prevent:

  STAGE 1  COMPANY IDENTITY   prevents: silently searching the wrong company
           Three measured ways to get a plausible wrong answer:
             kraken-exchange           -> 0 rows, slug wrong, company not empty
             evergreen-holding-company -> 104 UNRELATED real people, looks normal
             saturated API             -> hang, indistinguishable from an empty company
           Clay returns a clean empty array for a wrong domain. That honest behaviour is
           the property this stage needs.

  STAGE 2  RETRIEVAL          prevents: missing people who exist
           Clay partitioned by seniority band: 1,773 distinct at Airwallex vs 499
           unfiltered, 100% carrying a real current title.
           Union effect is SIZE-DEPENDENT: Exa+BrightData added 23-110% above ~100
           employees, nothing below ~50. Must measure the same for Clay.

  STAGE 3  SELECTION          prevents: inventing titles nobody holds
           THE ROOT CAUSE. decisionMakerTitles() plans titles before retrieval; only
           25-27% of them exist at a typical company. Selection must choose from OBSERVED
           titles only.

  STAGE 4  VERIFICATION       prevents: shipping a wrong or stale person
           Clay, BrightData, Exa and Apollo ALL derive from LinkedIn. Their agreement is
           ONE claim counted twice, not corroboration. Verification must be independent:
           first-party evidence from the company's own site.
           Four axes: IDENTITY, EMPLOYER, TITLE, FIT. All four must hold.

EACH STAGE NEEDS A FALLBACK, because BrightData is IP-blocked right now and a real system
must degrade rather than stop.

THE NUMBER THAT MATTERS AT THE END: the share of found people who survive all four
verification axes. Nobody has produced it yet. Finding 212 people at Harbor IT means little
if only 30 are verifiably the right person in the right job today.

---

## 11. APPENDED 20:05 — a data bug that invalidates earlier measurements

BUG, PROVEN  companies-export.json stores harbormsp.com for Harbor IT. The real domain is
        harborit.com. EVERY prior Apollo run in this project queried the wrong domain and
        got zero people back.
        THIS INVALIDATES the earlier finding "Apollo returned 0 senior hits at Harbor IT
        while Exa found 14". That was OUR data bug, not an Apollo limitation.
        Re-run against the correct domain: Apollo returns 19 buyer-shaped people at Harbor
        IT and 44 at Ntiva -- the BIGGEST raw contributor of any source, and free.
        Apollo caveat: names come back first-name + obfuscated-surname on this tier.

PROVEN  THE UNION CURVE FLATTENS AFTER THREE SOURCES, not two. Added best-first by solo
        recall against Harbor IT's 8 known seniors:
          +Exa        11 people   7/8 seniors
          +Apollo     22 (+11)    7/8   adds volume, ZERO marginal ground-truth seniors
          +BrightData 25 (+3)     8/8   closes the C-suite gap in BOTH companies
          +Findymail  25 (+0)     8/8   adds nothing
        Cost per marginal buyer: Apollo $0 < Exa ~$0.028 < BrightData ~$0.13 < Findymail worst.
        Findymail is slow (27-50s/call, one 504) and contributed 1 unique person total.
        Free company-leadership-page route: Harbor IT publishes NO named executives. Dead end
        for this vertical, which also explains stage 4's poor verification yield.

PROVEN  A NEW TITLE FAILURE MODE, and it is not the old one. Held-out run on form3.tech,
        5 companies, judge 66% (median 70%), within one SE of the 72% baseline, total cost
        $0.14 for 5 companies with NO BrightData.
        The SELECT model INVENTED non-observed titles on 3 of 5 companies despite an explicit
        verbatim-only instruction. It substitutes the CANONICAL ICP-vocabulary title ("CTO",
        "CISO", "VP Engineering") for a real but messier observed one ("Chief Architect, VP of
        Engineering") that it judges not close enough.
        The two worst-scoring companies were the two with the most invented titles.
        => Giving the model observed titles is NOT sufficient. It must be FORCED to select by
        reference (an index or id), never by retyping a title string.

STAGE ASSIGNMENT as measured (K-union-bakeoff):
  1 IDENTITY    Clay. Only source that tells "wrong domain" from "no people". BrightData
                returned 104 confident wrong people; Apollo returned a silent 0.
  2 RETRIEVAL   Clay by seniority band. Fallback Exa per-title + BrightData roster union.
  3 SELECTION   Clay -- the title arrives WITH retrieval, so selection becomes filtering an
                observed field rather than planning a title in advance.
  4 VERIFY      unresolved. All four providers derive from LinkedIn.

OPEN SEAM, flagged not guessed: Clay's report does not mention Alex van Lent (Harbor IT
Chief Transformation Officer), found only by Exa. Unknown whether Clay has him. This is the
one open question in "does any source add coverage Clay lacks".

HARNESS FIRST RUN (my own, single-pass, no loop):
  Harbor IT   32 senior -> 6 buyers -> 0/6 first-party verified
  Cyber Salus  6 senior -> 1 buyer  -> 0/1
  Ntiva       49 senior -> 3 buyers -> 1/3
  harbormsp.com WRONG DOMAIN -> correctly STOPPED at stage 1
  Cost: 176 Clay records, Exa $0.07, LLM $0.019
  => 1 of 10 verified. Either the verifier is too strict or the output is unshippable.
     M-verify's adversarial controls decide which.

---

## 12. APPENDED 20:13 — the stage-2 open seam, closed

MEASURED  Clay's unfiltered roster for harborit.com (212 people) checked against every
        senior person Exa or BrightData discovered separately:
          FOUND 12 of 13, each with the correct title attached, including
            Alex van Lent   Chief Transformation Officer   <- the seam K flagged
            Hannah Paige    Chief Financial Officer        <- K claimed BD was the ONLY source
            Johnny Lieberman CEO · Michael Sullivan CCO · Josh Oakes COO
            Eric Regnier Chief Services Officer · Jeff Dayton Director Shared Services
            Ananya Ridenour Director of Service Delivery · Jason Bricault Director InfoSec
            Autumn Coffee Director HR · Micah Ralph TA & Recruiting Ops · Makenzie Cox HR Ops
          MISSING 1: Laura Spurzem (Director of Human Resources). Note she was ALSO absent
            from BrightData's roster in the leak test, so she may be a genuinely hard case
            or no longer employed there.

=> CORRECTS K's conclusion. K measured the union curve WITHOUT Clay and concluded it
   flattens after three sources (Exa, Apollo, BrightData). With Clay as the base, Exa's
   marginal contribution at this company is 1 of 13.
=> K's specific claim "BrightData is the ONLY source with Hannah Paige" is FALSE.

TWO LIMITS, stated because this is exactly where this session has been sloppy:
  1. CONTAMINATED GROUND TRUTH. Every "known senior" was discovered BY Exa or BrightData.
     "Clay found 12 of 13" means "Clay found almost everyone Exa found". It answers
     "does Exa add anything Clay lacks" (barely) but NOT "who actually works there".
     An uncontaminated truth source is still missing.
  2. n=1 COMPANY, and the union effect was measured as SIZE-DEPENDENT (strong above ~100
     employees, redundant below ~50). This needs the same check at a 2,000-person company
     before it generalises.

DISCARDED  My matcher scored "Charles" as FOUND against a Detection Engineer. Charles F.
        has no surname in our data so the first-name match is spurious. Not counted.

---

## 13. APPENDED 20:14 — CORRECTION, plus a free endpoint that beats everything paid

CORRECTION, mine  I reported "a zero balance is NOT a spending guard -- it billed anyway"
        as PROVEN. That was WRONG and is retracted. The agent read a stale balance: the
        $10.00 top-up landed 19:50:13 and the calls landed 19:52:24, so the charges hit a
        FUNDED balance. I relayed the claim without checking it.
        WHAT IS TRUE and is the narrower real mechanism: a "free"-labelled endpoint reserves
        $0 up front and settles the REAL cost after the fact. So a pre-call balance check
        cannot protect you from a mislabelled endpoint. Confirm cost with GET /calls/{id}
        after one deliberate test.

PROVEN  A FREE ENDPOINT BEAT EVERY PAID ONE. Harbor IT, all priced before calling,
        balance $4.5038 -> $4.4869, total spend $0.0169:
          endpoint                        cost     people   titles   known seniors
          leadsforge.people.search        FREE      186     100%       8 of 8
          apollo.people.search            FREE      179     99.4%      5 of 8
          lusha.x.decision-makers         $5.49      44     100%       7 of 8
          aviato.companies.employees      $0.005      0     -          0 of 8
        leadsforge found ALL EIGHT alone for $0, including Michael Sullivan (Lusha's one
        miss) and Charles Fuller, who is NOT in our own 206-row BrightData ground truth.
        aviato is UNUSABLE: every identifier format (website, www-prefixed, linkedinURL)
        resolved to the WRONG company ("NetXperts") or returned zero, repeatably over 4 calls.
        hunter.x.multi-domain-search and leadmagic.x.employee-finder both 503'd with
        provider_capacity_unavailable -- treg's shared pools for those are exhausted.

PROVEN  IP-BLOCK WORKAROUND, partial. treg carries NO bulk BrightData roster equivalent --
        its BrightData wrapper exposes only single-record /datasets/v3/scrape, never the
        /datasets/filter + snapshot bulk API. BUT apollo.people.search and
        leadsforge.people.search both ran live from treg's own infrastructure, so they are
        free, IP-independent substitutes for "get this company's people".

=> leadsforge.people.search now belongs in the stage-2 comparison alongside Clay. Both are
   effectively free at this scale and both claim ~100% title coverage. Unmeasured: whether
   leadsforge holds up at 2,000-person scale, and whether it has Clay's honest wrong-domain
   behaviour. NOT yet tested.

## 13b. FINAL on the treg charge. Observation only, no inference.

The ledger, from GET /calls:
  call 1   balance $1.00     cost_observed $5.4912   cost_charged $1.0000   CAPPED by balance
  call 2   balance $4.50+    cost_observed $5.4912   cost_charged $5.4912   uncapped
Total charged $6.4962.

WHAT THIS SHOWS: the available balance DOES cap what you are charged. Call 1 is the proof.
WHAT IT DOES NOT SHOW: what happens at exactly zero. Nobody observed that. An agent inferred
a zero balance would record a block_shortfall and proceed anyway; that is a reading of the
mechanism, not a measurement, and it is NOT recorded here as fact.

THE OPERATIONAL RULE, which does not depend on resolving that: the catalog price label is
unreliable, a "free"-labelled endpoint settles its true cost AFTER the call, so price every
endpoint from the catalog, make ONE deliberate test call, and read GET /calls/{id} before
ever repeating it. Prefer routed treg.* ids, which carry X-Treg-Route-Max-Cost. Raw provider
ids carry no ceiling.

This is a side issue. It is closed. treg's data case is weak next to Clay and leadsforge;
its only open value is the unverified own-key integration layer.

---

## 14. THE EXPERIMENT DESIGN — codex, full detail in EXPERIMENT-DESIGN.md

THE HEADLINE ANSWER TO THE LOOP QUESTION:
  "The default should be a fixed provider cascade plus one ID-based selection pass. The
   adaptive loop must earn its complexity in Gate 2; until then, DO NOT BUILD IT."

THE STRUCTURAL FIX for the invented-title failure found in the held-out run:
  Use STABLE CANDIDATE IDS, not strings and not positional indexes. Indexes break when
  candidates are deduped or reordered between rounds. The model returns IDS ONLY; the system
  copies the observed title from the candidate record. Unknown IDs fail closed.
  No more prompt-only attempts to prevent invention -- enforce it structurally.

VALIDITY PRECONDITION, before any gate. A data contract, not an experiment:
  kraken-exchange must produce "invalid target", never "zero employees".
  Evergreen's unrelated people must fail company-identity matching.
  A BrightData timeout must be "provider unavailable", never an empty roster.
  Apollo-only records are LEADS, not returned people, until the obfuscated name resolves.
  Failure here invalidates the whole run.

GATE 1  PROFILE FIDELITY. Does the stored ICP preserve client intent?
  10 sellers x 20 candidates. Run the SAME selector twice: against the verbatim client
  brief, and against the stored ICP. That separates "profile compression corrupted intent"
  from "selection cannot operationalise intent".
  Pass: stored-ICP precision >=95%, recall >=85%, both within 5 pts of the raw brief.
  Cost ~$0.30-0.70 plus labelling. FAIL STOPS ALL RETRIEVAL WORK -- fix onboarding first.
  Do not continue because "most profiles passed": one 74%-vs-1% case makes aggregates
  meaningless.

GATE 2  DOES A LOOP BEAT THE STRONGEST FIXED CASCADE?
  Arm A, and the baseline must NOT be weak: Clay by the 8 seniority bands -> Apollo by
  seniority+department -> Exa broad plus <=2 resolution searches on Apollo's observed titles
  -> BrightData for unresolved C-suite gaps -> union+dedupe -> ID-based selection.
  Arm B: same candidate table, then AT MOST 2 adaptive rounds. Run both rounds even if a
  shadow judge says stop, otherwise there is no counterfactual.
  36 companies over >=6 sellers: 12 under 50 employees, 12 at 100-499, 12 at 500+.
  Pass on the 24 companies with 100+: >=12 additional buyers, >=1 at >=6 companies, marginal
  precision >=90%, paired-bootstrap 95% lower bound above zero.
  Cost: Clay 288 quota calls, Apollo $0, Exa <=$1.26, BrightData $25-75, OpenRouter ~$3.
  FAIL -> drop the loop and do not run Gate 4.
  Under 50 employees: default to NO loop.

GATE 3  CAN FIRST-PARTY EVIDENCE VERIFY ENOUGH TO SHIP?
  THIS ANSWERS MY QUESTION about the 1-of-10 result. Overall yield measures the JOINT system
  of pipeline correctness AND whether companies publish named employees. Separate them:
    publisher availability   fraction of domains where any named employee is findable
    conditional accuracy     confirmed / (confirmed + contradicted), only where evidence exists
    joint yield              confirmed / all outputs
  Low availability + few contradictions = sparse channel, NOT an inaccurate pipeline.
  High contradiction = the pipeline is wrong.
  "Harbor IT's 1/10 therefore does NOT imply nine bad selections. Combined with its website
   publishing no executives, it mainly predicts that universal first-party verification
   will fail."
  120 outputs from 40 companies, 3 each. Pass: >=84/120 confirmed, conditional accuracy
  >=98%, >=30/40 companies yield >=1 confirmed. Cost 280 Exa searches = $1.96.
  Futility stop: after each batch of 40, stop if confirmed + remaining < 84.

GATE 4  CAN THE JUDGE TERMINATE A LOOP? Only if Gate 2 keeps one.
  Reframe the question. Not "does this list look plausible" but the OBSERVABLE:
  "will another permitted round produce at least one additional qualifying buyer?"
  72 shadow decisions, 60 hard-negative controls (30 wrong-function, 30 stale).
  Pass: false-stop <=5%, >=90% of STOPs followed by a barren round, 0/60 hard negatives.
  The current 22% hard-negative FPR FAILS THIS BEFORE IT STARTS.
  One repair on a dev set, one fresh locked evaluation. Fails twice -> abandon judge-
  controlled termination. No model tournament.

RANKING BY DECISION IMPACT: Gate 1 > Gate 3 > Gate 2 > Gate 4.
RUN ORDER: 1 -> 2 -> 3 -> 4 (Gate 3 needs frozen output from the candidate method).

DO NOT RUN, explicitly:
  no provider winner contest · no more Apollo exact-title tests · no more cross-provider
  agreement studies among LinkedIn-derived sources · no more Harbor "known senior recall"
  claims · no capture-recapture (sources are correlated, assumption violated) · no Findymail
  retrieval experiment · no more prompt-only anti-invention attempts · no first-party
  expansion after Gate 3 fails on publisher silence · no BrightData accuracy run while
  blocked · no sub-50 complementarity study · no Clay has_more investigation · no judge
  model bakeoff.

DO NOT MODIFY THE ENGINE until Gate 2 shows adaptation is worth adding.

---

## 15. THE DETERMINISTIC / LLM BOUNDARY. A rule I broke repeatedly today.

THE RULE: what can be decided by reading a structured field is CODE. What requires judgment
about meaning is the LLM. Never approximate judgment with a regex, a substring test or word
overlap.

WHERE I BROKE IT, worst first:

1. WHO COUNTS AS A BUYER, decided by regex:
     /owner|founder|chief|president|\bvp\b|director|head of|service delivery|talent|
      recruit|human resources|\bhr\b/i
   "Would this person buy this product?" is the most judgment-heavy question in the pipeline.
   I answered it with alternation, and I instructed THREE agents to use the same shared regex
   "so the comparison is fair" -- which made it consistently wrong rather than correct.
   AFFECTED, and these must be re-derived with an LLM before being quoted again:
     - the union table (20 buyers at Harbor IT, 28 at Ntiva)
     - the 9-company generalisation (65 Exa / 53 BD / 99 union)
     - the marginal-contribution curve and "flattens after three sources"
     - the 88%/32% presence-versus-readable-title split
   What they actually measure is REGEX AGREEMENT BETWEEN SOURCES, not buyers.

2. FIRST-PARTY VERIFICATION, decided by word overlap:
     hit = titleWords.filter(w => after.includes(w)).length >= ceil(titleWords.length/2)
   Whether a page confirms employment is reading comprehension. Word overlap cannot separate
   "Jane Smith, CFO" from "Jane Smith reports to the CFO". This may fully explain the
   1-of-10 verification result I had been treating as a finding about the pipeline.

3. TITLE-TERM PROBING against the headline (already killed on other grounds, 19% recall).
   Substring matching cannot know "CEO" means "Chief Executive Officer".

4. NAME IDENTITY by first+last token key. It already failed on credential suffixes
   ("Mary Hart, MHA" vs "MHA Mary Hart"). Exact-match dedup is code; deciding whether two
   AMBIGUOUS records are the same human is judgment.

WHERE DETERMINISTIC CODE IS CORRECT AND MUST STAY -- all of these read a structured field
and involve no judgment:
   end_date === "Present"          current employment marker
   company_id === slug             employer identity
   canonical LinkedIn URL          lowercase, strip query/trailing slash, collapse the
                                   country subdomain (co.linkedin.com -> linkedin.com)
   dedup by exact canonical URL
   masked-title detection          /^[*\s]+$/ is a literal pattern, not a judgment
   pagination, cap detection, retry, timeout-as-unknown
   cost metering by in-run delta
   stable candidate IDs            codex's structural fix: the model returns IDs, code
                                   copies the title. Unknown ID fails closed.

THE PATTERN THAT MAKES THIS SAFE, and it is codex's ID design generalised:
   CODE decides WHAT IS TRUE about a record (fields, identity, currency).
   THE LLM decides WHAT IT MEANS (is this a buyer, does this page confirm employment,
   are these two records the same person).
   The LLM never returns free text that code then parses for meaning -- it returns an ID or
   a label from a closed set, and code does the rest.

---

## 16. CODEX ANSWERS on the three open design questions (CODEX-ANSWERS.md)

Q1 GATE 0 -- REJECTED, and the reasoning corrects me.
   I proposed a Gate 0: "can a synthesizer infer the buyer from an account definition alone?"
   Codex: "It would measure whether a model can guess an unstated buyer, not whether the
   guess is correct." You cannot score an inference without knowing the right answer.
   INSTEAD: the client's stated intent ("growth side, not compliance side") becomes part of
   the CLIENT-INTENT RUBRIC/FIXTURE. Gate 1 then needs client-labelled GROWTH POSITIVES and
   COMPLIANCE NEGATIVES. If both selectors return compliance people they fail on PRECISION,
   which is the detection I was trying to build a separate gate for.
   Raw-versus-stored agreement alone is NOT the pass condition.

Q2 THRESHOLDS CONTAMINATED BY MY BUYER REGEX -- these must be re-derived:
     Gate 2  >=12 additional buyers across 24 companies
     Gate 2  >=1 additional buyer at >=6 companies
     Gate 2  round-two >=6 across 24
     Gate 2  the 0.5-per-company small-company override
     Gate 2  the size-based no-loop default
   Re-derive from a SEPARATE DEVELOPMENT SAMPLE's blinded, human-adjudicated A-versus-B
   buyer delta using an explicit client buyer rubric -- never source agreement, never regex
   matches -- then FREEZE them before the 36-company evaluation.
   These bars were chosen independently and STAND: >=90% marginal precision, bootstrap lower
   bound above zero, <=2-point overall precision loss, the structural zero-error rules.
   Gate 1, 3 and 4 thresholds were NOT derived from the regex figures. But any regex-created
   LABELS or CONTROLS inside them must be replaced.

Q3 PER-PERSON REASONS -- YES, as a CLOSED-SET label in the SAME call:
     {"id":"candidate_123","basis":"explicit_persona_match"}
     {"id":"candidate_456","basis":"inferred_workflow_owner"}
   No free text. No separate explanation call -- that only produces post-hoc rationalisation.
   Log `basis` for DIAGNOSIS ONLY. NEVER parse it to decide eligibility, ranking, or the
   returned title.
   This is what makes the hard case auditable: it distinguishes "the profile told it to pick
   compliance" from "it failed to infer the buyer", which look identical in the output and
   need opposite fixes.

BLOCKER, and it is a genuine dependency on the client, not something I can measure my way
around: Gate 1 needs a CLIENT-LABELLED FIXTURE -- real people at real companies, labelled by
the client as buyers or non-buyers under their own rubric. Without those labels there is no
ground truth for intent, and every alternative I have (provider agreement, a regex, a judge
with a 22% wrong-function error) is exactly the kind of self-referential measurement this
whole session has been poisoned by.

---

## 17. EMERGENT COUNT — PROVEN across a 44x headcount range

9 Aris companies, offline from bd-aris.json, corrected currentTitleAt, no network calls.
Evergreen excluded (identity trap). All 9 companies x 3 methods x judge ran in UNDER 3
MINUTES, M3 costing $0.0163 total.

  company              headcount  titled   M1   M2   M3
  etrepid                     10       5    0    1    0
  cyber-salus                 21       5    1    2    2
  newboldtech                 44      17    2    2    3
  cyberlinkasp                52      20    2    5    4
  frsecure                   109      46    7   16    2
  harbor-msp                 206      53    5    9   13
  das-health                 248      81    2    5   11
  centre-technologies        288     107    4   13   19
  ntiva-inc-                 445     191   10   21   41

PROVEN  NO METHOD PADS. None converges on a fixed number. All track company size, from 0-2
        selected at a 10-person company to 10-41 at a 445-person one. This is the client's
        core requirement -- "if a company only has two people in that department, return
        two" -- and it now holds across a 44x headcount range.

DIAGNOSTIC, the three shapes differ and the difference is informative:
  M1 deterministic  flat ~1-2% of headcount at EVERY size above 40. A fixed rule finds a
                    constant FRACTION, which is its own insensitivity -- it cannot notice
                    that one company has an unusually deep bench and another does not.
  M3 per-person     share GROWS with size, 2% at 206-248 employees up to 9% at 445. The
                    opposite of padding, but could be over-inclusion at scale rather than
                    better recall. UNRESOLVED without clean labels.
  M2 title-list     erratic, 35% of the titled pool at one company and 6% at another, no
                    size relationship. The noisiest of the three.

PROVEN  COST AND SPEED ARE NOT THE OBJECTION TO PER-PERSON LLM SELECTION. I had assumed M3
        was too slow and dear to ship. Measured: under 3 minutes for all 9 companies and
        $0.0163. That assumption was mine and it was unmeasured.

NOT A RESULT  Judge column M1 73%, M2 36%, M3 52%. With a 22% wrong-function error rate the
        judge cannot separate these. M2 scoring half of M1 is more likely judge noise than a
        real gap. No winner can be called until Gate 1 supplies clean labels.

---

## 18. BUDGET. What this probe cost, and what made it expensive.

BUDGET WAS $10. I did not track it as it accrued and only totalled it when asked. That is
the process failure; the numbers below are the consequence.

CONFIRMED
  treg                       $6.4962   two calls to ONE endpoint
  Exa + OpenRouter           ~$2.23    today's share of a $12.32 cumulative ledger
                             -------   (the rest predates this session's people work)
                             ~$8.73

UNCONFIRMED, and unresolvable from here
  BrightData                 up to $8.36 at the published $2.50 CPM
                             A-aris $3.85 · D-freshness $2.36 · G-leak $1.63 · E-sel $0.52
  BrightData's own `cost` field read $0 on EVERY snapshot and /customer/balance returns 403,
  so the true figure cannot be reconciled without the account invoice. Worst case today is
  ~$17 against a $10 budget. Best case ~$8.73.

WHAT MADE IT EXPENSIVE, in order:
  1. treg, $6.50 = 65% of the budget, on ONE endpoint called twice. It is labelled
     type "free" in the vendor's own catalog and bills $5.4912 uncapped. I compounded it by
     writing a FALSE SAFETY ASSUMPTION into the agent brief ("a metered call at zero balance
     will 402 harmlessly") that I had never observed.
  2. BrightData drains, ~$8.36 at published rate. Draining full rosters was the right
     experiment but I let four agents each drain overlapping company sets. A-aris drained
     1,528 records; D-freshness re-drained three of the same companies; G-leak drained two
     more. Coordinating the drain ONCE and sharing the file would have cost a third.

WHAT IS ACTUALLY CHEAP, and is what the method should be built on:
  Clay      bundled annual quota, 1.5M records/yr. The whole Clay probe used 0.22% of it.
  Apollo    free.
  Analysis  offline against rosters already on disk. Costs nothing.
  Exa       $0.007/search, only needed for verification, not retrieval.
  The expensive providers -- BrightData and treg -- are the two the final method does not
  depend on.

RULES FOR NEXT TIME:
  - Report spend PER AGENT as it accrues, never total it at the end.
  - Never state a safety property of a paid API that has not been observed.
  - One agent owns each paid retrieval; the rest read its file.
  - Price an endpoint from the catalog, make ONE test call, read the cost, and only then loop.

---

## 19. VERIFICATION SOLVED. Two independent sources, measured against controls.

THE EXPERIMENT: 18 cases -- 12 real pipeline outputs across both verticals and every company
size, plus 6 controls that MUST be rejected (3 people whose Harbor IT role genuinely ended,
2 real people attached to the wrong employer, 1 invented person). Three methods, same cases.

  method                       real confirmed   controls wrongly confirmed
  A  the company's own site        2/12  17%          0/6
  B  the open web                 10/12  83%          1/6
  C  Exa structured people index   9/12  75%          0/6
  B AND C                          8/12  67%          0/6   <- SHIPPABLE

METHOD A WAS MY MISTAKE, and it explains results I had been reporting as pipeline failures.
Restricting evidence to the company's own domain confirms 2 of 12. Small companies do not
publish leadership pages -- Harbor IT names no executives at all. The earlier "0 of 7" and
"1 of 10" verification results measured MY METHOD, not the pipeline.

WHY BOTH SOURCES ARE NEEDED, and the case that proves it:
  Nicholas Hearne genuinely LEFT Harbor IT. Method B CONFIRMED him -- the open web still
  carries the old association. Method C said UNKNOWN. The AND rule caught him.
  A single source cannot see that failure.
  B contributes ACTIVE REJECTION: it CONTRADICTED 4 of 6 controls.
  C contributes INDEPENDENT STRUCTURED CONFIRMATION: an open-ended workHistory row with a
  matching employer.

THE EIGHT CONFIRMED span both verticals and 44x of company size:
  Chief Services Officer, Harbor IT (206 emp) · CIO and VP Operations, CyberlinkASP (52)
  HR Director, NewBold (44) · Co-founder/CEO and Co-Founder/CPO, ARQ · CPO, Seccl
  Co-Founder/CTO, Relay

THE FOUR UNCONFIRMED ARE HONESTLY UNKNOWN, NOT WRONG. Three were simply absent from Exa's
top-10 people index (a recall limit that can be widened by raising numResults); one had no
open-web coverage at all.

HONEST CAVEAT: C's perfect control record is PARTLY LUCK. It returned UNKNOWN for all six
because they were not in the indexed top-10, not because it actively rejected them. If a
departed person WERE indexed with a stale record, C could confirm them wrongly. B is what
actively contradicts. Do not read C's 0/6 as a safety property.

COST: $0.378 Exa + $0.147 LLM for all 18 cases across 3 methods = about $0.03 per person
verified by two independent sources.

---

## 20. NEW SESSION (Fable) — methodology experiment, pre-registered. x/DESIGN.md

TAKEOVER. The previous phase established provider facts; it did not test a methodology.
This phase does, with the design written and reviewed BEFORE any result exists.
Budget $10 new. Ledger per agent in x/ledger/*.jsonl. Nothing in src/ changes.

DB CLEANUP requested by the user: blocked by the harness classifier (mass delete). SQL left
at /tmp/cleanup.sql for the user to run. The DB is localhost:5432/algo, dev only. The probe
does not depend on it.

DESIGN after codex review (x/CODEX-REVIEW-1.md), the four changes it forced:
  1 recall denominator was circular -> a blinded REFERENCE SET from Clay's full senior roster
    built before any method runs (REF), labelled by a validated judge, positives verified.
  2 judge gate was underpowered (20 negatives -> ~14% upper bound) -> >=60 held-out negatives
    incl. >=20 INTENT-CONTRADICTING (function matches ICP text, contradicts client intent),
    >=30 positives, DEV/LOCKED split, LOCKED used once. Advisor added: >=5 negatives with NO
    ICP vocabulary in the title, >=10 positives whose verdict depends on company context.
  3 loop coverage was the planner grading itself -> coverage = reference-positive ids absent
    from round 1; round-2 value = recovered ids.
  4 thresholds were noise at n=20 -> a policy wins only on >=6-0 discordant company wins
    (sign test p=0.031). The 2-point precision allowance is dropped (needs ~865 people).
  Plus codex's cheapest high-value experiment: SELECTOR ABLATION over identical rosters,
  raw ICP vs ICP+rubric intent. Advisor framing: (a) = what the engine does today,
  (b) = the ceiling if onboarding captured buyer intent. NOT a method win.
  BrightData enrichment moved OUT of the comparison into a separate capped probe.

KIT x/providers.mjs: verified call shapes only, every call banks to a per-agent ledger.
  Smoke: clay/apollo/exa/brightdata/llm/dedupe/verify all pass, $0.028.
  NEW FACT: Clay accepts a LinkedIn company URL as company_identifier (harbor-msp -> 11).
  That is the stage-1 fallback when a stored domain is wrong.
x/plan-schema.mjs: validatePlan() fails closed on any filter value outside the provider's
  real set, so an invented Clay band cannot become a silent zero.

PHASE 0 DONE (REF, $0.0475, ~8 min): universe.json, 20 companies.
  Airwallex 275 · Poshmark 235 · Kraken 170 · Discord 157 · Ramp 137 · MoonPay 80 ·
  Polymarket 59 · Ntiva 49 · Harbor IT 31 · DAS 27 · Seccl 26 · Centre 21 · Relay 21 ·
  Arq 15 · Evergreen 14 · NewBold 11 · FRSecure 10 · CyberlinkASP 8 · Cyber Salus 6 · eTrepid 2
  STAGE 1 WORKED on both planted faults: Harbor IT domain -> 0, LinkedIn URL -> 31.
  Evergreen: slug wrong (BrightData 104 strangers) but DOMAIN resolves to the real company,
  a PE roll-up (Alpine Investors, "Co-Founder and M&A Partner"). Kraken: slug -> BD 0,
  domain -> Clay 170. Domain-first with LinkedIn fallback is the resolution order.
PHASE 1 RUNNING (JUDGE): 93 controls confirmed by a second model, 21 excluded as ambiguous.
PHASE 3 RUNNING (GATE): LLM-planned fan-out, retrieval only, cap $3.

ATTRIBUTION FIX: a commit went in with an AI co-author trailer from the harness default;
the user's CLAUDE.md forbids it. Amended. Zero trailers in the last three commits.

## 21. JUDGE GATE PASSED — the instrument is valid (locked split, used once)
  negatives 76, FALSE POSITIVES 0, rule-of-three upper bound 3.9%   (target <= 5%)
  positives 24, TP 22, recall 92%                                     (target >= 85%)
  intent_contradicting: 36 negatives, 0 judged POSITIVE, 0 INFLUENCER
    -> the class the old judge failed at 22% is now rejected 36/36.
  departed 5/5 rejected · too_junior 15/15 · wrong_function 18 NEG + 2 NOT_APPLICABLE
  misses: "HR Manager at Harbor Networks" -> not_at_company (sibling brand; defensible),
          "Senior Director of Product Design" @ Discord -> wrong_function (design is not
          product ownership; the control was borderline). judge errors 0.
  Cost to build and validate: ~$0.80.

GATE (retrieval policy) DONE: all 20 companies, planner rejected values 0.
  NEW candidates beyond Clay's universe: 83 total. Airwallex 38, Ramp 29, MoonPay 5,
  Discord 3, Harbor IT 3, Centre 2, Arq/Polymarket/Relay 1, all ten small MSPs 0.
  ROUND 2 ran at 7 companies (observable gaps): marginal 0 at all seven.
  Cost $0.82 for 20 companies. Cyber Salus $0.357 (an exa-agent run at a 21-person firm).
  PENDING: JUDGE labels the 83 to see whether "beyond Clay" means buyers or noise.
ABL spawned (selector ablation, raw ICP vs ICP+rubric, same rosters, same ids).

## 22. Context accumulation decision + a regression I caused and caught (21:50-22:05)
DECISION (user asked): two tiers. During finding, keep what providers already return as
append-only evidence rows (tenure start, dated work history, the open-web pages the verifier
already fetches). Deep context (BrightData posts, Exa agent podcasts/talks) is the separate
enrich endpoint that already exists, per verified buyer, capped. Context RANKS and
personalises; it never decides eligibility. Recorded as DESIGN.md REVISION 2.
CHANGE: verify.mjs web read now returns {verdict, hook_quote, hook_url, hook_date} in the
same call. Zero extra provider cost.
REGRESSION: after the change, a person previously CONFIRMED came back UNKNOWN. Cause:
maxTokens 300 on a reasoning model -> the model spent the budget thinking and returned EMPTY
text -> parsed as UNKNOWN. Fix: maxTokens 1500; empty reply flagged `empty:true`. Re-tested
3/3 verified (strong) and verified on the fast model with hook "ZAG Technical Services has
joined Harbor IT" -- an acquisition, exactly the signal the user described, captured free.
JUDGE was told to HOLD its verify pass during the repair and then cleared. No corrupted data.
LESSON: a closed-set JSON reply from a reasoning model needs token headroom; an empty
reply must be distinguishable from a genuine UNKNOWN.
CONFIRMED: exa-web with text contents bills $0.007, same as without.

## 23. JUDGE stopped on budget, not on failure (22:15)
Labelling the big Ondato rosters with the strong model is the dominant cost: Airwallex,
Kraken, Discord, Arq = $1.68. JUDGE reserved for verify and stopped, leaving 16 companies
unlabelled including all ten cheap Aris ones. Cap raised to $5.00; order smallest-first.
FINDING, judge instability: the same Airwallex roster labelled twice on identical input
gave 10 vs 9 POSITIVE and 4 vs 8 INFLUENCER; Discord 11 vs 15 INFLUENCER. Single-run labels
carry roughly that much noise. The locked gate (0/76 FP) is not affected, but per-company
recall against R should be read with this in mind.
GATE and JUDGE both idled 13-30 min waiting on notifications that had fired. Nudged. The
pattern is consistent: agents that put work behind a background task and then wait.

## 24. The judge solves the Ondato intent problem at the instrument level (22:20)
Titles judged POSITIVE at Kraken (25 of 166): Director of Organic Growth, Head of Growth -
Consumer, Head of Growth derivatives, Head of Regional Growth, Product Director Payments,
Director of Product Management - Onchain, Head of Institutional Product ...
Airwallex (9 of 275): VP Product Risk & Onboarding, Chief Product Officer, Global Head of
Growth, Head of Growth DACH, VP Product Developer Ecosystem ...
Discord (5 of 157): Senior Director of Product, Director of Product Management ...
Arq (3 of 15): Head of Growth, Co-Founder and CPO, VP Product & AI Ops.
ZERO compliance, AML, KYC, risk-function or legal people labelled POSITIVE at any of the
four. COOs at >100-person companies -> INFLUENCER (rubric). Engineering directors ->
INFLUENCER/wrong_function (rubric). Kraken's 25 is EMERGENT: a large exchange has that many
product-line growth heads. Not inflation.
=> With the client's intent written into the rubric, the validated judge picks the growth
   side. The open question ABL answers: does the SELECTOR given only the raw ICP do the
   same, or drift to compliance as the old pipeline did (74% vs 1%)?

## 25. GATE (LLM front-gate retrieval) — measured, 20/20, $0.82 (x/GATE-report.md)
PLANNER BEHAVIOUR: 0 rejected filter values anywhere. It almost never called Apollo or Exa
in round 1: it treated Clay's free senior universe as covering those slices and paid only
for the MANAGER band, keyworded HR/recruiting/onboarding. Cost-aware fan-out worked.
=> The gate's marginal value over Clay-senior is concentrated in ONE slice: the sole HR /
   recruiting manager at a small MSP (Micah Ralph, Harbor IT; Lisa Ramirez, Centre), a real
   buyer under the Aris rubric that a senior-only roster misses. 83 new candidates total,
   almost all at Airwallex (38) and Ramp (29) from the manager band; small MSPs 0-3.
ROUND 2: fired at 7/20 on one deterministic trigger (manager-band Clay returned 0 rows).
   Marginal recovered: 0 at all seven. Where it pivoted to Apollo by department it got
   12-25 rows each, but Apollo surnames are obfuscated and no other provider landed on the
   same person, so none resolved. APOLLO IS A LEAD SOURCE, NOT A PEOPLE SOURCE.
EXA AGENT: one call at Cyber Salus, effort low, billed $0.225 (7.5x the ~$0.03 estimate)
   for 4 candidates already in U. Zero marginal value. REMOVE from the method.
KEYWORD AMBIGUITY: "growth" at Airwallex returned ~20 sales/marketing "growth" titles, not
   onboarding-product owners. Keywords bias retrieval; the judge must still decide.
IDENTITY: Harbor IT domain->0 then LinkedIn->rows; Evergreen resolved by domain, no
   conflict. No confident-wrong and no confident-empty roster.
PROCESS: an orphaned background test process burned $0.37 before GATE caught it; disclosed
   and included in the $0.82. Second time today an agent lost money to backgrounding.

## 26. JUDGE done: labels for all 20, gate re-locked and held, verification incomplete
GATE RE-RUN after the advisor's harder controls were added (composition changed, so DEV ->
LOCKED once more): 76 negatives 0 FP (upper 3.9%), incl. 7 VOCAB-FREE intent-contradicting
negatives, 0 FP; positives 100% recall on the new LOCKED. The repair cycle changed the
CONTROL POOL (removed ambiguous compound titles), not the judge prompt. DEV recall 78.6% ->
93.8% after cleaning controls.
CONTEXT-DEPENDENT POSITIVES: only 5 exist in the fixture (advisor asked for 10) -- no Ondato
company is under the ~100-employee founder carve-out (smallest is Arq at ~160-230). Reported
as a gap, not manufactured.
MoonPay: 24 of 80 ids came back malformed on one call -- a real coverage hole, flagged.
GATE'S 83 "BEYOND CLAY" CANDIDATES: only 44 were labelled before JUDGE's budget ran out
  (Ramp 29, MoonPay 5, Discord 3, Harbor IT 3, Centre 2, Polymarket 1, Relay 1); AIRWALLEX'S
  38 AND ARQ'S 1 WERE NEVER JUDGED. Of the 44: 0 POSITIVE at Ramp; 4 POSITIVE total (Centre
  Technologies, Harbor IT -- the sole HR/recruiting managers), 3 verified.
  CORRECTION 22:55: an earlier line here said "0 positive among the 67 at Airwallex and
  Ramp". Airwallex was not labelled. Retracted. THAT IS THE LLM GATE'S ENTIRE MARGINAL CONTRIBUTION over Clay-senior: three
  verified buyers across twenty companies, all in one slice (manager band, HR function, small
  MSP). It is real and it is narrow.
VERIFICATION STOPPED at 5 of 20 companies: JUDGE ran its own script with the old $2.80 cap
(never picked up the $5.00 raise) and a DUPLICATE BACKGROUND PROCESS re-ran three companies,
wasting ~$0.15-0.20. Third agent today to lose money to backgrounding. 21 verify calls:
15 verified, 2 contradicted, 4 unknown. Spot-check 7/7 agreement fast vs strong. exa-web
32/32 rows at exactly $0.007.
=> I am filling the remaining 15 companies myself: verify-fill.mjs, one sequential process,
   ledger JUDGE2, cap $1.50, positives ordered by seniority band, 6 per company as
   pre-registered. R is therefore CAPPED AT 6 per company by design; recall-vs-R is fair to
   selectors that pick at most 6.
EXAMPLE of the two-source rule holding: Rahul Kumar, "US Growth Lead" at Airwallex -- web
CONFIRMED with hook "joined Airwallex as Senior Partnerships Manager", index UNKNOWN ->
status unknown. The hook itself shows the title has moved. One source alone would have
shipped a wrong title.

## 27. VERIFICATION COMPLETE, all 20 companies (fill: one sequential process, $1.03)
  checked 93 judged positives (<=6 per company, pre-registered)
  VERIFIED 68 · contradicted 7 · unknown 18   -> 73% of judged positives verified by two
  independent sources; 7.5% actively contradicted; 19% honestly unknown.
  Every company has R >= 1. Ondato's ten: 36 verified growth/product people (the case
  that scored 1% against intent before). Aris's ten: 32.
  Per company R: Airwallex 4 · Arq 2 · Discord 4 · Kraken 4 · MoonPay 5 · Polymarket 4 ·
  Poshmark 3 · Ramp 5 · Relay 2 · Seccl 3 · Centre 4 · Cyber Salus 3 · CyberlinkASP 2 ·
  DAS 4 · Evergreen 1 (PE holding co, 4 unknown) · FRSecure 3 · Harbor IT 5 · NewBold 4 ·
  Ntiva 5 · eTrepid 1.
  100% of verified buyers carry a free web hook from the verification pass (a CONFIRMED
  verdict implies the page named them, so a quote exists; QUALITY is what HOOK measures).
  Cost of verification: $1.03 / 93 = $0.011 per person checked, $0.015 per verified buyer.

## 28. THE RESULT (aggregate.mjs over ref/reference.json, ABL/results.json, GATE/results.json)

SELECTOR ABLATION -- identical rosters, model, candidate ids, cap 6; ONLY the input differs
                             precision   hard-neg rate   recall vs R
  (a) raw stored ICP            0.47         0.28            0.51
  (b) ICP + buyer intent        0.95         0.00            0.70
  paired by company: b>a 18, a>b 0, ties 2, two-sided sign p<0.001. SEPARATED (>=6-0).
  by size band, raw-ICP precision: <50 0.69 · 50-499 0.54 · 500+ 0.16
=> THE DOMINANT FAILURE IS SELECTION UNDER A PROFILE THAT DOES NOT NAME THE BUYER. Given the
   stored ICP alone, 28% of picks are intent-contradicting hard negatives (compliance people
   at Ondato) and at 2,000-person companies precision is 16%. With buyer intent captured,
   95% precision and zero hard negatives. Retrieval was never the problem.
   (a) = what the engine does today. (b) = the ceiling if onboarding captured buyer intent.
   THE FIX IS AT ONBOARDING, and it costs nothing at retrieval.

RETRIEVAL POLICY -- selector fixed to (b)
                             precision   recall vs R   beyond Clay    round-2 marginal
  Clay senior bands             0.95        0.70          --              --
  LLM front-gate fan-out        1.00        0.71       83 -> 3 verified   0 at all 7
  paired recall 4-4 (p=1.0), precision 4-0 (p=0.125): NOT SEPARABLE at n=20.
=> The LLM gate does not beat a free Clay roster plus a good selector. The per-company loop
   recovered nothing. The gate's one real contribution is the MANAGER band keyworded HR /
   recruiting at small MSPs (3 verified buyers across 20 companies). Apollo is a lead
   source; the Exa agent is not worth its cost for people.

VERIFICATION: 93 checked, 68 verified (73%), 7 contradicted, 18 unknown. Every company >=1.
TOTAL COST $5.34 including building and validating the judge.

## 29. THE ONDATO PICK LISTS — same roster, same model, same ids, one input differs
RAMP   (a) raw ICP:  Head of Compliance and Financial Crime · Global Head of Financial Crimes ·
                     Head of Compliance Operations · Head of Compliance & MLRO · Head of Risk ·
                     Head of Fraud Management                       -> 6 of 6 HARD NEGATIVES
       (b) +intent:  CPO · Director of Product Management · Head of Strategic Growth ·
                     Senior Director Product Management · Co-founder, Growth -> 5 of 5 POSITIVE
KRAKEN (a) Chief Compliance Officer x3 · COO/Head of Bizops · Director Global AML/CFT · ...
       (b) Head of Product Management · Senior Director of Product · Product Director Payments ·
           Head of Growth · Global Director & Head of Growth · Derivatives Product Director
AIRWALLEX (a) Senior Director Reg Compliance · 2x Associate Director Regulatory · Director
              Compliance & MLRO · Associate Director Global FCC · Chief Product Officer
          (b) Chief Product Officer · Product Director Ecosystem · Senior Director PM · Head of
              Product Strategy · Global Head of Growth · Head of New Payment Flow
DISCORD (a) VP Trust & Safety · Global Head of Product Policy · Senior Director Product Law ·
            Director Public Policy · Director Product · Chief Legal Officer
        (b) Director of Product Management · Senior Director PM · Director Product · Sr Dir Product
SECCL   (a) Head of Risk · Chief Risk Officer · CPO · CTO · Head of Launch · Director of Ops
        (b) Chief Product Officer · Growth Director · Growth Director
=> This is the 74%-vs-1% failure reproduced exactly and then removed by ONE input.
SPOT-LABEL SHEET generated: x/SPOT-LABEL-SHEET.md, 58 shuffled rows mixing verified buyers
with judged hard negatives, for the user to mark Y/N/?. Any 20 rows is the only real ground
truth in the experiment.

## 30. CODEX FINAL REVIEW (x/CODEX-REVIEW-2.md) — accepted, it sharpens the claims
1 CIRCULARITY. Arm (b) receives the rubric and is judged by a model implementing the same
  rubric. 0.95 = rubric-conditioned selector agreement with a rubric-conditioned judge.
  Two-source verification confirms identity/employer/title, NOT buyer fit.
  DEFENSIBLE CLAIM: "on this fixture, explicit buyer criteria eliminated most disagreement
  with the experiment's buyer rubric at zero incremental retrieval cost." It does NOT yet
  establish 0.95 real-buyer precision. The separating check is blinded client labelling --
  the spot-label sheet already delivered.
2 RETRIEVAL. "No retrieval benefit was demonstrated; effects of practical size remain
  uncertain." Not "adds nothing" -- equivalence was not tested (would need ~40 paired
  companies). Operationally no evidence justifies shipping an LLM gate: equal recall,
  zero round-2 recovery, avoidable provider cost. KEEP one deterministic fallback: Clay's
  keyworded manager band for small MSPs whose senior roster has no HR/recruiting owner
  (3 verified buyers at 2 companies). No LLM planner, no broad "growth" keywords.
  On the 11 companies where recall-vs-R can discriminate (judged positives <= 6):
  GATE better 1, Clay better 0, ties 10; both 1.00 at 9 of 11.
3 RECALL 0.70 = macro-average of |picks ∩ R| / |R| where R is the verified subset of at
  most 6 judge-positives from Clay's senior bands. NOT recall of all real buyers. Ntiva
  (26 positives, R=5, both arms recall 0 at precision 1.0) is a cap artefact.
4 PRODUCTION METHOD (codex, 10 lines) recorded in people-method.md.
  NEXT MEASUREMENT before the engine changes: blinded client-labelled selector precision.
  PASS: intent arm >= 90% precision, >= 20-point lift over raw ICP, ZERO intent-
  contradicting picks.
