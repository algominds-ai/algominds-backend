# Find-people methodology experiment — design

GOAL. Prove a method that, given an ICP, finds the RIGHT people at each target company, at
scale, without errors. The output is a method the engine can adopt, not a provider verdict.
Nothing in src/ changes. Budget $10 hard, planned $6.50, tracked per agent in x/ledger/.

FIXTURE. Two real sellers, 20 real companies, as stored by find-companies:
  arissearch.com  10 MSPs, 10 to 445 employees. Includes harbormsp.com, a WRONG stored
                  domain (real: harborit.com), and evergreensg.com whose stored LinkedIn
                  slug is a different company. These stay wrong on purpose: stage 1 must
                  catch them.
  ondato.com      10 fintech/consumer platforms, 15 to 2,364 employees. The ICP is written
                  around compliance vocabulary but the client wants the product/growth side
                  that owns signup and onboarding conversion. Compliance/AML/KYC officers are
                  the HARD NEGATIVES here.
Neither ICP names the buyer person. Both define the account. The method must infer the
buyer and say on what basis.

WHAT "RIGHT" MEANS, per person, all four required:
  identity   a real, specific person with a canonical LinkedIn URL
  employer   works at this company NOW
  title      current and correct
  fit        would own the budget or the decision for this purchase under the ICP rubric
And per company: the set is not padded (count tracks the company's real structure) and no
obvious buyer is missed relative to the union of everything any method found.

MEASURING INSTRUMENT. No client labels exist, so:
  1. A written BUYER RUBRIC per seller (x/fixture/rubric-*.md), built from the ICP doc plus
     the client's stated intent, naming positives AND hard negatives.
  2. A blinded rubric JUDGE with a strong model, VALIDATED FIRST against controls before it
     scores anything: 10 wrong-function hard negatives, 5 stale/departed, 5 wrong-employer.
     Gate: hard-negative false-positive rate <= 5%, else the judge is repaired or the result
     is reported as unmeasurable. The judge returns a label from a closed set plus a basis,
     never free text that code parses.
  3. Verification is deterministic-then-model: Exa structured people index (open-ended
     workHistory row, employer match) AND an open-web read by the model with
     CONFIRMED/CONTRADICTED/UNKNOWN. Both must agree. Measured today: 8/12 real confirmed,
     0/6 controls wrongly confirmed, and it caught a departed employee that one source alone
     confirmed.
  4. A 20-person sheet for the user to spot-label at the end. Cheapest real ground truth.

THE THREE METHODS, same fixture, same judge, same verifier:
  M-SEQ   fixed cascade, no LLM at the gate for provider choice.
          Clay by the 8 senior seniority bands -> dedupe -> model selects by candidate ID
          with a closed-set basis -> verify B AND C.
          This is the baseline. It must be strong, not a straw man.
  M-GATE  LLM at the front gate, dynamic fan-out.
          The model reads the ICP + company (name, domain, industry, headcount from Clay
          count) and emits a PLAN: buyer personas with basis, and per-provider filter specs:
            clay      seniority bands + optional title keywords
            apollo    seniorities + departments (never named titles)
            exa       people-search query strings, N each
            exa-agent at most 1 run per company, effort low, only when the model says the
                      structured index will be thin (small or obscure company)
          The plan must justify each provider call and must not ask two providers for the
          same slice. Execute -> union by canonical URL -> record per-provider overlap ->
          model selects by ID with basis -> verify B AND C -> BrightData enrich the verified
          set (activity/posts, row timestamp) for a personal hook.
  M-LOOP  M-GATE plus a coverage check: after round 1 a model compares the selected set to
          the planned personas and names uncovered personas; the gate replans filters for
          those only; round 2 executes only those; max 2 rounds. Measure round-2 MARGINAL
          verified buyers. If the marginal is ~0 the loop is dead.

METRICS, per method x company, then per size band (<50, 50-499, 500+):
  candidates per provider; overlap between providers (paid twice?)
  selected count and its ratio to headcount (emergent?)
  verified (B AND C) count; unknown count; contradicted count
  judge: precision on selected; on verified
  recall proxy: share of the cross-method union of verified+judged-positive people found
  cost per provider; cost per verified buyer; wall time
  M-LOOP only: round-2 marginal verified buyers
  stage-1 outcome on the two wrong-identity companies

DECISION RULES, fixed now:
  M-GATE beats M-SEQ if it finds >=1 additional verified judged-positive buyer at >=4 of the
  20 companies at <=2 points lower precision, or if it finds the SAME set at lower cost.
  M-LOOP earns its round if round 2 adds >=1 verified judged-positive buyer at >=4 of 20.
  A method is disqualified if it returns a judged hard negative as a top pick at >2 companies.
  The wrong-identity companies must produce "identity unresolved" or a resolved identity,
  never a confident empty or a confident wrong roster.

BUDGET CAPS per agent: SEQ $0.75, GATE $2.00, LOOP $2.00, JUDGE $1.00, ENRICH $0.75.
Clay is annual quota (free). Apollo free. Exa $0.007/search, agent ~$0.03 at effort low.
BrightData $0.0025/record. Every call banks to x/ledger/<agent>.jsonl with dollars+records.

RULES every agent obeys: probe only, never touch src/; only the call shapes in
x/providers.mjs (they are the verified ones); no regex or substring for any judgment about
meaning; selection by candidate ID only; labels from closed sets only; a timeout is UNKNOWN
never empty; report MEASURED numbers only; stop at the cap.

# REVISION 1 — after codex review (CODEX-REVIEW-1.md). This supersedes the phases above.

PHASE 0  REFERENCE UNIVERSE  (agent REF, cap $0.10, output x/ref/universe.json)
  For all 20 companies: Clay by the 8 senior bands, deduped -> U(company). Stage 1: try the
  stored domain; if empty, try the stored LinkedIn company URL; record which resolved and
  whether the two disagree. BrightData count by slug as a headcount signal only.
  This is built BEFORE any method runs and is the shared denominator. Nearly free.

PHASE 1  JUDGE, VALIDATED  (agent JUDGE, cap $2.80)
  Rubric judge over candidate records, closed-set label POSITIVE / INFLUENCER / NEGATIVE /
  NOT_APPLICABLE plus a closed-set basis. Controls, built from U plus the rosters on disk:
    >= 60 negatives held out and NEVER reused during repair, including >= 20 of the class
    that matters: current, senior, correct-employer people whose function matches the ICP
    text but contradicts client intent (Ondato compliance/AML/KYC/risk leaders; Aris CFOs,
    sales VPs, vCISOs). Plus departed and wrong-employer for the verifier side.
    >= 30 positives, so an always-negative judge cannot pass.
  DEV split for one repair; LOCKED split for the gate. Gate: 0 FP on locked negatives AND
  >= 85% recall on locked positives. Fail twice -> report "buyer fit unmeasurable".
  Then label all of U. Verify (B AND C) the top-6 judged positives per company.
  -> x/ref/reference.json: per company, the verified rubric-positive IDs = R(company).

PHASE 2  SELECTOR ABLATION  (agent ABL, cap $1.00) -- codex's highest-value experiment
  Identical roster U(company), identical model, identical ID protocol, identical top-pick
  cap (6). Vary ONLY the selector's input: (a) raw ICP description; (b) ICP + rubric intent.
  Score both against R. This says whether the dominant failure is selection/intent, at
  LLM cost only. All 20 companies.

PHASE 3  RETRIEVAL POLICY  (agent GATE, cap $3.00) -- vary ONLY retrieval
  Selector fixed to (b). Same ID protocol, same cap, same verification budget.
    R-CLAY  = U itself. Recall vs R is ~1 by construction; it is the oracle baseline, ~$0.
    R-GATE  LLM plan -> Clay bands+keywords / Apollo seniority+dept / Exa people queries /
            <=1 Exa agent run at low effort -> union. The question is what it finds that is
            NOT in U: rubric-positive, verified, beyond Clay's blind spot. And its cost.
    R-LOOP  R-GATE, then OBSERVABLE coverage: reference-positive IDs absent from round-1
            selection; round 2 retargets those only; marginal = recovered reference IDs plus
            any new verified positives. Max 2 rounds.
  Decision: a policy is better only on >= 6-0 discordant company wins (sign test p=0.031).
  Anything less is "not separable at n=20" and is reported as such.

PHASE 4  HOOK PROBE  (agent HOOK, cap $0.50, serialised, AFTER phase 3)
  For <= 40 verified buyers: BrightData row by URL. Has activity? row age? cost. Separate
  from the comparison on purpose.

PHASE 5  USER SPOT-LABEL SHEET. Top 3 per company for 5 Ondato + 5 Aris. The only real
  ground truth. Produced at the end, blinded to method.

COST CONTROL: every agent books model tokens too (llm() banks usage.cost). Caps hold.

# REVISION 2 — context accumulation (user question, 21:50)

PRINCIPLE. Find-companies keeps the SIGNAL because it is what makes the outreach relevant.
For a person the equivalent is the recent thing that makes the message land: a post about
the problem, a new role, a talk, a hiring post they wrote. Context RANKS and PERSONALISES;
it never decides eligibility. The judge decides who; context decides what to say and whom
first.

TWO TIERS, split by cost and freshness, not preference:
  DURING FINDING, free, already paid for -> store as append-only evidence rows
    (subjectType person; kinds: tenure_start, prior_role, location, web_mention{url,quote,
    date}, verification{source,verdict}). Sources: Clay start date, Exa dated workHistory,
    the open-web pages the verifier ALREADY FETCHES (today read once and discarded).
  ENRICH, per verified buyer, separate endpoint (src/core/enrich already exists) ->
    BrightData row (activity posts, about, certifications, row age) $0.0025; Exa agent with
    media providers for podcasts/talks ~$0.03-0.10. On demand, capped, only after
    verification and judge.

CHANGE TO THE PROBE:
  verify.mjs web read returns {verdict, hook_quote, hook_url, hook_date} in the SAME call.
  Closed shape. Zero extra provider cost. Stored per person in results.
  HOOK (phase 4) now measures: of the verified buyers, share with a dated open-web mention
  captured FREE by verification; share with a usable BrightData post and its age; cost per
  person with at least one hook. That is the measured answer to "gather during vs later".
