# Finding the right people: the measured method

Twenty real companies, two real sellers, one pre-registered experiment. Every
number below was measured on 2026-09-01 and every threshold was written down
before the result existed. The raw material behind this document, and the
earlier provider probe that fed it, live under `people-probe/`, untracked. See
"Where the raw material lives" at the end of this document.

## The finding that locates the failure

The engine's precision problem is not retrieval. It is selection under a
profile that never names the buyer.

Identical rosters, identical model, identical candidate ids, a cap of six
picks. The only difference between the two arms is what the selector reads.

| selector reads | precision | intent-contradicting picks | companies where it won |
|---|---|---|---|
| the stored ICP only | 0.47 | 28% of picks | 0 |
| the stored ICP plus the client's buyer intent | 0.95 | 0 | 18 of 20, two ties |

Two-sided sign test p < 0.001 against a pre-registered rule of six-to-nothing.
At companies over 500 people the stored-ICP arm reaches 0.16.

At Ramp, an Ondato target, the ICP-only arm chose six compliance and risk
titles: Head of Compliance and Financial Crime, Global Head of Financial
Crimes, Head of Compliance Operations, Head of Compliance and MLRO, Head of
Risk, Head of Fraud Management. The intent arm chose growth and product
people instead: the CPO, the Director of Product Management, the Head of
Strategic Growth, the Senior Director of Product Management, the Co-founder
for Growth. Kraken, Airwallex, Discord and Seccl repeat the pattern.

The honest reading, from the second review: explicit buyer criteria removed
almost all disagreement with the experiment's buyer rubric, at zero retrieval
cost. The rubric encodes what the client said. Whether the rubric matches what
the client would actually mark is what the spot-label sheet tests, and
nothing else in this experiment can.

### Retrieval: no benefit from an LLM front gate was demonstrated

With the selector fixed, an LLM-planned fan-out across Clay, Apollo, Exa
search and the Exa agent was compared against Clay's eight senior seniority
bands alone.

| retrieval | precision | recall against the reference | beyond the free roster | second round |
|---|---|---|---|---|
| Clay senior bands | 0.95 | 0.70 | — | — |
| LLM front gate | 1.00 | 0.71 | 83 found, 44 labelled, 3 verified buyers | 0 recovered at all 7 companies it fired |

Paired recall 4–4, precision 4–0: not separable at twenty companies. On the
eleven companies where recall can discriminate at all, both reach 1.00 at
nine. The planner rejected no filter values and almost never called Apollo
or Exa: it recognised the free roster already covered senior slices and paid
only for Clay's manager band. Its three real finds are the sole HR or
recruiting manager at a small MSP — one deterministic fallback, not a
planner.

Apollo's surnames are obfuscated and never resolved to a person another
provider confirmed; it is a lead source. One Exa agent run cost $0.225 for
four people already in the roster.

### Verification: one Exa agent run, and the honest unknown

Two verifiers were measured on the same 18-case control set: 12 real people
across both verticals, 3 who had left the company, 2 real people attached to
the wrong employer, and 1 invented person.

| verifier | real confirmed | controls wrongly confirmed | evidence | cost | time |
|---|---|---|---|---|---|
| Exa people index AND open-web model read | 8 of 12 | 0 of 6 | web pages found by search | $0.014 | ~3 s |
| Exa agent, effort minimal, structured output | 10 of 12 | 0 of 6 | 17 of 23 confirmations on the company's own site | $0.012 | ~20 s |

The agent contradicted the invented person, both wrong-employer cases, and
one departed employee; it left the other two departed employees unknown. It
confirmed two Seccl executives the people index does not hold, by finding
`seccl.tech/about` — it searches for first-party evidence rather than being
confined to a domain, which is why a domain-restricted search confirmed only
2 of the same 12. Effort `low` gave identical verdicts at $0.035.

The two-source rule, and the quote guard it needs: five of the agent's 23
confirmations cited data aggregators, which are derived from LinkedIn and are
not independent. The output schema therefore carries `evidence_kind` as a
closed set — first party, press, aggregator, LinkedIn — assigned by the
agent. A confirmation resting only on aggregator or LinkedIn evidence gets the
people index as a second opinion; a first-party or press confirmation stands
alone. Two of 36 runs cited an `evidence_url` that did not contain the quote,
so the quote must be found on the cited page before the URL is stored; if it
is not, the verdict stands and the URL is dropped. Code reads the label and
checks the quote is on the page. Nothing else in verification is
deterministic.

On the full run the two-source rule checked 93 judged positives, at most six
per company: 68 verified, 7 contradicted, 18 unknown, every company with at
least one, $0.011 per person. Measured for the context API, not for this
pipeline: the verifier's page read yielded a specific-event opener for 30 of
the 68 at no extra cost, 37 dated inside 180 days, and BrightData's collected
profile added 7 more on the 38 without one for $0.095. Context is not this
pipeline's job — the finding API returns the right people, every provider
reply is stored raw as evidence, and a separate context API reads it later.

### The judge, and what it can and cannot say

A rubric judge, validated on a locked split used once: 76 negatives with no
false positive (upper bound 3.9%), including 36 whose function matches the
ICP text but contradicts the client's intent and 7 whose titles carry no ICP
word at all; full recall on the locked positives. The same roster labelled
twice on identical input moved one positive and four influencers, so
single-company figures carry about ten points of label noise. The
eighteen-to-nothing selector result sits far outside that; individual company
precisions do not.

Recall against the reference is Clay-bounded and capped: the reference holds
the verified members of at most six judge-positives per company. At Ntiva, 26
judged positives and a reference of 5, both selector arms scored zero at
precision 1.0. That is the cap.

### The count is emergent, not padded

An earlier provider probe measured this across a 44-times headcount range,
offline against stored rosters: 0 to 2 people selected at a ten-person
company, up to 10 to 41 at a 445-person company. No method converged on a
fixed number or a fixed fraction of headcount. Those counts predate the
method's six-pick cap at stage 4; inside the method the count is emergent
below six, and an empty result is a valid result. This is the client's core
requirement: a company with two people in the buying function returns two.

### Spend

$5.61 for everything, including building and validating the judge. Two agents
lost money to orphaned background processes ($0.37 and about $0.20) and both
are in the ledger. The expensive providers of the earlier probe, BrightData
rosters and treg, are not in the method.

## The method

| stage | does | provider | fallback | cost |
|---|---|---|---|---|
| 0 onboarding | capture the buyer separately from the account: the workflow they own, budget or decision role, explicit exclusions, size-dependent exceptions | model, seller's site and brief | ask the client | once |
| 1 identity | resolve the company by domain; if empty, by the stored LinkedIn company URL; if both fail, stop as unresolved | Clay | none, by design | ~0 |
| 2 retrieve | the eight senior bands, one call each; at a small MSP with no senior HR owner, add the manager band keyworded for HR and recruiting | Clay | Exa people search per persona | quota |
| 3 dedupe | canonical LinkedIn URL, then name key | code | — | 0 |
| 4 select | at most six candidate ids plus a closed-set basis; the model never emits a title; an empty result is a valid result | model with the buyer criteria | — | $0.02 |
| 5 verify | one Exa agent run, effort minimal, structured output: verdict, evidence url, verbatim quote, `evidence_kind`, confidence; aggregator-only confirmation gets the people index as a second opinion; silence is unknown and is excluded | Exa agent | people index + web read | $0.012 |
| 6 store | write the person, and every provider's raw reply as append-only evidence, unshaped | code | — | 0 |

No Apollo, no Exa agent for retrieval, no second round, no LLM planner in the
default path. A twenty-company run costs about one dollar.

### What is a parameter and what is a provider

Seniority bands are a parameter of the buyer, not a constant of the method.
Clay exposes fourteen bands, founder through intern and unknown; the eight
senior ones were the setting for these two buyers. Stage 0 captures who buys,
stage 2 maps that to bands, and the rubric names the positives. A seller
placing interns retrieves the junior bands plus whoever hires them. The
manager-band rule at small MSPs is this mechanism already varying bands by
company.

After the row mapper no stage reads a provider-specific field. Stage 2's
contract is an identifier in and `Candidate { name, title, company, url,
since }` out; a provider is an object literal, so replacing one touches one
file. Three implementations of that contract were measured: Clay, complete
rosters on an annual quota; Exa people search, 13 to 14 per company at $0.007
per query; and leadsforge through treg, free, 8 of 8 known seniors at one
company. Verification has the Exa agent with the two-source rule as its
fallback. Clay is the only source measured to give a complete roster cheaply,
and the method's cost rests on that today.

Edge cases the run met, not imagined: a wrong stored domain and a wrong
stored slug, both caught at stage 1; a private-equity holding company with
sibling brands, one verified and four honestly unknown; a Latin-American
company whose evidence was in Spanish, confirmed through Forbes Argentina; a
person whose title had moved since the roster, held back; a ten-person
company, one buyer. Not yet met: a company over about five thousand people
where one band could pass the 499-row cap, which partitioning by location
handled at Airwallex.

### Four ways to get a confident empty answer, each with its guard

A wrong stored slug returned zero rows. A wrong-identity slug returned 104
real strangers that looked normal. A saturated BrightData account hung with
no status code. A reasoning model given too few tokens returned empty text
that parsed as unknown. The guards: resolve identity before retrieval; treat
a timeout as unknown, never as empty; distinguish an empty model reply from a
genuine unknown; and fail closed on any filter value outside a provider's
real set.

### Before the engine changes

Measure blinded, client-labelled selector precision on the delivered sheet.
Pass only if the intent arm reaches at least 90% precision, at least a
twenty-point lift over the stored-ICP arm, and zero intent-contradicting
picks. The sheet holds 58 shuffled rows mixing verified buyers with judged
hard negatives; twenty labelled rows are enough to start.

## The code-versus-model boundary

The rule: code decides what is true about a record — a field, an identity,
whether something is current. The model decides what a record means — is
this a buyer, does this page confirm employment, are two records the same
person. The model returns an id or a label from a closed set. It never
returns free text that code then parses for meaning. Never approximate
judgment with a regex, a substring test, or word overlap.

The experiment broke this rule four times, worst first, and had to re-derive
numbers each time:

- **Who counts as a buyer, decided by a shared regex.** Three agents applied
  the same title regex "so the comparison is fair," which made it
  consistently wrong instead. It invalidated the union table, the
  nine-company generalisation, the marginal-contribution curve, and the
  presence-versus-readable-title split — all of it measured regex agreement
  between sources, not who is a buyer. Fix: an LLM call with a buyer rubric.
- **First-party verification, decided by word overlap.** A page "confirmed"
  employment if half its words matched the title's words, which cannot tell
  "Jane Smith, CFO" from "Jane Smith reports to the CFO." This fully
  accounts for an early one-of-ten verification result once read as a
  finding about the pipeline. Fix: the model reads the page and returns a
  verdict.
- **Title-term probing against a provider's headline field**, on the
  assumption that a substring match could stand in for title meaning. It
  reached 19% recall and was dropped. Fix: read the structured title field a
  provider offers, or ask the model.
- **Name identity by a first-plus-last-name token key.** It failed on
  credential suffixes, matching "Mary Hart, MHA" against "MHA Mary Hart" as
  different people. Fix: dedupe on the canonical LinkedIn URL; treat a
  genuinely ambiguous pair as a model question, not a string key.

What stayed correct throughout, because each reads one structured field with
no judgment involved: `end_date === "Present"` as the current-employment
marker, `company_id === slug` as employer identity, the canonical LinkedIn
URL for dedupe, a masked-title pattern match, pagination and cap and retry
and timeout handling, cost metering by in-run delta, and a stable candidate
id that the model copies and code resolves — an unknown id fails closed.

## Verified provider cookbook

Call shapes below were observed working in the probe. Secrets live in
`.env`, referenced here by key name only.

### Clay — the retrieval source the method is built on

Base `https://api.clay.com/public/v0`, header `clay-api-key: $CLAY_API_KEY`.
Two steps; a single call does not work.

```
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
```

Row fields: name, url (LinkedIn), latest_experience_title,
latest_experience_company, latest_experience_start_date, matched_experience,
location. Filters that work: `company_identifier` (domain or LinkedIn
company URL, an array), `job_title_seniority_levels_v2`,
`job_title_keywords`. The fourteen seniority bands: founder, owner,
board-member, partner, c-suite, vp, director, head, manager, senior,
mid-level, entry, intern, unknown.

The 499 cap: one unfiltered query silently caps near 500 rows, and
`has_more:false` is returned at the end of every slice, including partial
ones — it never means the index is exhausted. Partition by seniority band,
one query per band, and union the distinct LinkedIn URLs. At Airwallex, an
unfiltered query returned 499; the union of seniority bands returned 1,773;
the union of country bands returned 1,637. The senior bands alone never
approach the cap — 296 people in 8 calls at a 2,364-person company — so the
cap never binds for buyer discovery.

Cost is not per-call. It draws on a bundled annual record quota
(1,500,000/yr on this workspace), and the in-run quota delta is exactly 1:1
with rows returned. The counter is not monotonic across runs, because it is
a shared production key; attribute cost by in-run delta, never by snapshot.

Wrong-domain behaviour: querying `harbormsp.com`, the wrong domain then
stored for Harbor IT, returns `{"data":[],"has_more":false}` — a clean
empty, no hallucinated people. The best failure behaviour of any provider
measured.

### Exa — verification and first-party evidence

Header `x-api-key: $EXA_API_KEY`. `POST https://api.exa.ai/search` for people
search:

```
{ "query":"<titles> at \"<Company>\"", "category":"people", "type":"fast", "numResults":10 }
```

Returns `entities[].properties` with a structured `workHistory` carrying
dates; a current role has `dates.to === null`. This category rejects
`startPublishedDate`, `endPublishedDate`, and `excludeDomains`;
`includeDomains` is accepted. Full request-and-response detail lives in
`exa-search-contract.md`, the later, filter-by-filter probe.

For verification, `POST /agent/runs` with `effort: "minimal"` and a
structured output schema is the method's stage 5. It cost $0.012 per person
in the full run, $0.035 at effort `low` with identical verdicts. The
cheaper, weaker fallback pairs the Exa people index with an open-web model
read: $0.014, confirming 8 of 12 real people against the agent's 10 of 12.
A search narrowed with `includeDomains` confirmed only 2 of the same 12 —
the parameter constrains which pages evidence may come from, it does not
filter by employment, so narrowing it loses coverage rather than adding
precision.

### Not in the method, and why

- **Apollo** — free, but surnames are obfuscated and never resolve to a
  person another provider confirms. A lead source, not a people source.
- **BrightData** — three dataset endpoints exist and only `/datasets/search/{id}`
  returns a real, unmasked title; `/datasets/v3/trigger` is a logged-out
  scrape, `/datasets/filter` can stall 25+ minutes. Under load it IP-blocks
  with no status code, and twelve agents on one account triggered a block
  that did not lift in 25+ minutes.
- **treg** — catalog price labels cannot be trusted: an endpoint labelled
  `type: "free"` billed $5.49 per call, uncapped. Routed `treg.*` endpoints
  carry `X-Treg-Route-Max-Cost`; raw provider ids carry no ceiling at all.
- **Findymail** — does title search, but slow (27 to 50 seconds per call,
  one 504 observed) and contributed one unique person across the whole probe.
  Worst cost per marginal buyer of any source measured.
- **Nango, Composio** — auth and integration infrastructure. They manage
  OAuth connections to other apps and cannot find a person.

## Mistakes that must not be repeated

- **Wrong endpoint declared a provider incapable.** BrightData's logged-out
  `/datasets/v3/trigger` was read as "cannot verify a title." Fix: verify
  quality against `/datasets/search/{id}` before ruling a provider out.
- **`end_date: null` read as the current-role marker.** The string
  `"Present"` marks current; `null` marks a shape whose titles sit in
  `positions[]` instead. Fix: test both shapes against a known roster first.
- **Twelve agents on one BrightData account.** It IP-blocked with no status
  code and did not recover for 25+ minutes. Fix: serialise BrightData calls
  and treat a timeout as unknown, never empty.
- **Cost claim reported as proven from a stale balance read.** "A zero
  balance is not a spending guard" was retracted: a top-up had landed just
  before the charge. Fix: never state an unobserved safety property of a
  paid API.
- **The treg overspend.** Two calls to a raw provider id labelled `"free"`
  billed $5.49 each against a $1.00 grant. Fix: one deliberate test call,
  then `GET /calls/{id}`, before ever looping on an endpoint.
- **A shared regex decided who counts as a buyer; word overlap decided
  employment confirmation.** Both invalidated every number they touched.
  Fix: both decisions moved to the model as a closed-set label.
- **A 300-token budget on a reasoning model caused a silent verifier
  regression.** It spent the budget thinking, returned empty text, and a
  confirmed person reverted to unknown. Fix: raise the token budget and flag
  an empty reply separately from a genuine unknown.
- **Known bugs in the project's own store caused false provider failures.**
  `harbormsp.com` was stored for Harbor IT instead of `harborit.com`, and
  two LinkedIn slugs were wrong (`kraken-exchange`, zero rows;
  `evergreen-holding-company`, 104 unrelated people). Fix: verify a stored
  identifier before blaming the provider.

## Where the raw material lives

All local-only, untracked, under `docs/solutions/people-probe/`:

- `design.md` — the pre-registered design and the two adversarial reviews
  that reshaped it.
- `results.md` — every company, every verified buyer by name, and what the
  raw ICP would have picked instead.
- `reports.md` — the five agent reports: judge, selector ablation, retrieval
  gate, agent verifier, hook.
- `diagrams.md` — the pipeline, the internal architecture, and the contracts
  between stages.
- `provider-probe.md` — the earlier session's full provider-by-provider
  findings, source of the cookbook above.
- `spot-label-sheet.md` — the 58 shuffled rows for the client to mark, the
  only real ground truth on intent.
- `kit/` — the runnable code: verified provider call shapes, dedupe,
  verifier, plan validator, scorer.
- `data/` — the reference set, the fixture ICPs and rubrics, and the agent
  verifier's raw verdicts.
- `people-providers.md`, `people-probe-log.md` — the full cookbook and
  mistake log this document distils, kept for detail.
