# The Exa /search contract, as measured

Probed live against `api.exa.ai` on 2026-08-27, with the request schema pulled
from `https://api.exa.ai/openapi.json`. Where the docs and a probe disagree,
the probe wins.

## Parameters that exist

| Parameter | Values | Note |
|---|---|---|
| `query` | string | The only required field. |
| `type` | `instant` `fast` `auto` `deep-lite` `deep` `deep-reasoning` | Default `auto`. |
| `category` | `company` `publication` `news` `personal site` `financial report` `people` | |
| `numResults` | 1-100, default 10 | Public maximum is 100. |
| `includeDomains` / `excludeDomains` | up to 1200 entries | Hostname, path prefix, or `*.example.com`. |
| `startPublishedDate` / `endPublishedDate` | ISO 8601 | |
| `userLocation` | two-letter ISO country code | Ranking signal, not a filter. |
| `additionalQueries` | 1-10 strings | Deep search types only. |
| `systemPrompt` | string | Source preference, novelty, and duplication guidance. |
| `outputSchema` | JSON Schema | Synthesized output. Adds about 2 seconds. |
| `contents` | object | `text`, `highlights`, `summary`, `extras`, `subpages`, `maxAgeHours`. |
| `moderation`, `compliance`, `stream` | | |

## Parameters that do not exist

`includeText` and `excludeText` are in neither the OpenAPI schema nor the docs.
A probe with `includeText: ["zzqqxvnonexistentphrase"]` returned five normal
results, so Exa drops the field without an error. Any code that sends them is
sending nothing.

`startCrawlDate` and `endCrawlDate` are deprecated and have no effect.

`neural` and `keyword` are not valid `type` values.

## The company category is a structured index, not a web search

`category: "company"` does not return web pages. It returns records from Exa's
own organization library, each with an `entities` array:

```
entities[0].properties = {
  name, foundedYear, description,
  workforce:    { total },
  headquarters: { address, city, postalCode, country },
  financials:   { revenueAnnual, fundingTotal, fundingLatestRound },
  webTraffic:   { visitsMonthly, countryRank, avgDurationSeconds, history },
  research
}
```

Fill rates over one 92-result response:

| Field | Filled |
|---|---|
| `name`, `description`, `headquarters.country` | 92 of 92 |
| `workforce.total` | 87 of 92 |
| `foundedYear` | 80 of 92 |
| `webTraffic.visitsMonthly` | 57 of 92 |
| `financials.fundingTotal` | 27 of 92 |
| `financials.revenueAnnual` | 20 of 92 |
| `research`, `headquarters.postalCode`, `financials.fundingLatestRound` | 0 of 92 |

So headcount and country are reliable enough to filter on in code. Revenue is
not: four rows in five carry no value, and a hard filter on it drops good
companies.

## What the company category refuses

`startPublishedDate`, `endPublishedDate`, and `excludeDomains` return a 400:

> The company category does not support the following filters:
> startPublishedDate. These categories use dedicated indices that only support
> semantic search.

`includeDomains` is accepted. `type` is accepted and then ignored:
`resolvedSearchType` comes back empty.

## Measured cost and latency

| Request | Results | Time | Cost |
|---|---|---|---|
| `numResults: 100`, `category: "company"` | 92 | 1.6 s | $0.089 |
| `numResults: 5`, plus `contents.summary.schema` | 5 | about 100 s | $0.012 |

One 100-result call returns more usable companies, with better data, in one
sixtieth of the time.

## The Agent API is a different endpoint with a provider array

`POST /agent/runs` takes `query` (the only required field) plus:

| Field | Values |
|---|---|
| `systemPrompt` | source preference, novelty, and duplication guidance |
| `outputSchema` | JSON Schema for `output.structured` |
| `effort` | `minimal` `low` `medium` `high` `xhigh` `auto` `max` |
| `previousRunId` | chains a run onto an earlier one |
| `dataSources` | up to 5 entries of `{ "provider": ... }` |
| `budget` | `{ "maxCostDollars": 1 to 100 }`, default cap $5 |
| `input.data` | records the agent should work from |
| `metadata` | caller-provided strings |

`dataSources` is the provider array. Allowed values:

```
fiber, financial_datasets, similarweb, baselayer, affiliate, particle, jinko
```

`/search` has no provider array. Only `/agent/runs` does.

## There is no free contract check

An earlier note recorded that an unknown category returns an empty result set
at zero cost. Measured again on 2026-08-27, that is no longer true:

| Request | Results | Cost | Error |
|---|---|---|---|
| `category: "zzz-not-a-real-category"` | 2 | $0.007 | none |
| `type: "neural"` (not a valid enum value) | 2 | $0.007 | none |

Exa accepts both, ignores both, bills for both, and reports no error. That is
the same silent-acceptance behaviour that let `includeText` and `type:
"neural"` sit in the code unnoticed.

Two consequences:

- A live contract test costs about $0.007 per call. It must not run inside
  `bun run gate`, which runs many times a day. Keep it a separate command and
  run it deliberately.
- A contract test cannot assert "the vendor rejects a bad field", because the
  vendor does not reject it. It has to assert the opposite: that our own code
  never sends a field outside the measured request schema. That check is free
  and belongs in the gate.

## The Agent API can cap its own spend; `/search` cannot

`POST /agent/runs` accepts a native per-run spending limit:

```
budget.maxCostDollars   $1 to $100, for effort "auto" and "max" only
                        default $5 for auto, $20 for max
```

That is a hard cap Exa enforces itself, which is stronger than checking a
ledger after each call. It is tempting for spend safety. It is still the wrong
tool for company discovery, for three measured reasons:

- It exists only on `/agent/runs`. `/search` has no budget field.
- Its floor is $1. One `/search` round costs $0.089, so the minimum budget is
  more than eleven times a whole round.
- The Agent API is far slower. `/search` returned 92 structured company records
  in 1.6 seconds.

It also caps only Exa. A run pays Apollo, Findymail, and the model gateway too,
and Exa's budget cannot see any of that. A ledger check across every vendor
can.

Use `effort: "auto"` with `budget.maxCostDollars` if a deep-research path is
ever added, where the work is genuinely open-ended and a vendor-enforced
ceiling is worth its price. Do not use it for the discovery path.

## Correction: the Agent API is cheaper than `/search` at a fixed effort

An earlier section here, and two statements made while planning, said the Agent
API was slower and dearer. Measured on 2026-08-27 with the same query:

| | `/search` + `category: company` | `/agent/runs` + `effort: low` |
|---|---|---|
| Wall clock | 1.6 s | 5 s |
| Cost | $0.089 | **$0.025** |
| Companies returned | 92 | 2 |

The "$1 minimum budget" applies only to `budget.maxCostDollars` on the metered
`auto` and `max` efforts. A fixed effort has no budget floor. The claim was
wrong for `low`.

## The two endpoints answer different questions

`/search` returns breadth: 92 company records with structured fields, which our
own filter and judge then sort. `/agent/runs` returns a short, evidenced list —
it stopped at two with `stopReason: "schema_satisfied"`, because the schema
asked for companies and never asked how many.

The agent's evidence is the kind a judge would otherwise have to infer, naming
the founder and the operating model in prose. Ask for a count in the schema, or
raise the effort, to get more rows.

## The async shape

`POST /agent/runs` returns immediately with an id and `status: "running"`. Poll
`GET /agent/runs/{id}` until `status` is `completed`. The probe took 5 seconds.

The completed run carries `output.text`, `output.structured` matching the
supplied `outputSchema`, `usage`, and an itemised `costDollars`:

```
costDollars: { total, agentCompute, search, emails, phoneNumbers }
usage:       { agentComputeUnits, searches, emails, phoneNumbers }
```

`emails` and `phoneNumbers` are billable lines, so the agent can return contact
details. That overlaps the enrichment path, not only discovery.

`dataSources: [{ "provider": "fiber" }]` is accepted without error.

## The agent finds contact details, with provenance

Measured: asking for the founder's work email at one named company returned a
complete person record in 26 seconds for $0.025.

```
fullName     Kirk Marple
title        Founder and Chief Executive Officer, Graphlit
email        kirk@graphlit.com
linkedinUrl  https://www.linkedin.com/in/kirkmarple
source       https://www.linkedin.com/posts/kirkmarple_...
```

Two things matter here.

**It cites a source.** Findymail returns an address and nothing about where it
came from. A cited URL is exactly what the append-only `evidence` table stores,
so a later reviewer can judge the value rather than trust it.

**The billable email counter stayed at zero.** `usage.emails` was 0 and
`costDollars.emails` was $0. The address came from search, not from a dedicated
lookup, so the whole run billed as ordinary agent compute plus search.

**Twenty-six seconds is the constraint.** Thirty people run serially would take
about thirteen minutes. That rules the agent out as the first enrichment
provider and rules it in as the next one: Findymail first because it is fast
and cheap, the agent after it for the misses, where slow and evidenced beats
empty.

## `category: "people"` returns structured person records too

The people path currently sends `category: "linkedin profile"`, which is not in
Exa's category enum and is accepted only as a loose hint, together with
`contents.summary.schema` LLM extraction. That is the same shape removed from
the company path for being slow and lossy.

`category: "people"` is a real category and behaves like `company`. Measured at
the same $0.007, it returns `entities[0].properties`:

```
name, firstName, lastName, location, workHistory, educationHistory, research
```

`workHistory` is the important one. Each entry carries a title, dates, and the
employer as an object with an `id`:

```
title    "Chief Executive Officer, Technical Founder"
dates    { from: "2021-02-01", to: null }
company  { id: "https://exa.ai/library/organization/lrjlz4ht43v",
           name: "Graphlit, by Unstruk Data" }
```

`to: null` marks the current role, and that `company.id` is the same identifier
the `company` category returns.

## This is the fix for the employment name collisions

A previous run matched roughly a third of thirty people to a different company
sharing a name — two "Passage" companies, an "Aspiro Therapeutics" against an
"Aspiro". The code compares company name strings, so a collision is inevitable.

With `workHistory`, employment is checkable by identifier: a person belongs to
the target company when a work entry has `to: null` and a `company.id` equal to
the company's own. No string comparison, no model judgement, no confidence
score to threshold.

The existing `employmentConfidence` of 0.4 records the doubt but nothing acts
on it. Matching on id removes the doubt instead of scoring it.

## Overlap and repeated work, as it stands

| Scope | Mechanism |
|---|---|
| Companies across runs | `seenDomains`, a 90-day window, rejecting `already-seen` |
| People within one run | `dedupeAcrossCompanies`, keyed on LinkedIn URL |
| People across runs | none |

The third row is a real gap. `person.linkedin_url` is unique, so a repeat
insert is discarded, but the paid search that found the person again still ran.

## Second correction: agent cost scales with the work requested

The comparison above used a run that returned two companies for $0.025 and drew
a general conclusion from it. That was wrong. Asked for ten companies with the
same prompt, the agent cost **$0.905**.

Head to head, both producing ten companies:

| | `/search` pipeline | `/agent/runs`, effort low |
|---|---|---|
| Companies | 10 | 10 |
| Wall clock | 158 s | 48 s |
| Cost | $0.1375 | $0.905 |

The `/search` figure is the entire pipeline: the Exa call, the synthesizer, and
the judge. The agent figure is the agent alone, before any judging.

So the agent is about 6.6 times dearer for the same output, not cheaper. The
earlier $0.025 measured a run that stopped at two rows with
`stopReason: "schema_satisfied"` and had barely worked.

Its targeting was good: all ten were US companies with headcounts from 0 to 18,
inside the profile. Speed and quality are real. Cost is the trade.

`exa-search` stays the default for discovery. The agent earns its price where
evidence matters more than volume, or where search cannot reach at all — which
is why it sits last in the enrichment waterfall rather than first.

**The lesson worth keeping:** measure at the size you intend to run. A probe
that returns two rows says nothing about a request for a hundred.

## The request schemas are checked against the spec, not written from memory

The category enum had been written from memory. It invented four values Exa
does not have — `research paper`, `pdf`, `github`, `linkedin profile` — and
omitted one it does, `publication`. Because `linkedin profile` was in our enum,
the people path could send it and nothing objected.

An enum copied from memory is a comment, not a constraint.

Compared mechanically against `api.exa.ai/openapi.json`, the `/search` request
schema now matches exactly:

| | Spec | Ours |
|---|---|---|
| Fields we send that the spec does not define | — | none |
| `numResults` | 1 to 100 | 1 to 100 |
| `includeDomains`, `excludeDomains` | 1200 | 1200 |
| `type` | instant, fast, auto, deep-lite, deep, deep-reasoning | identical |
| `category` | company, publication, news, personal site, financial report, people | identical |
| agent `effort` | minimal, low, medium, high, xhigh, auto, max | identical |
| agent `dataSources` | 7 providers, at most 5 | identical |

Modelling fewer fields than the spec is safe. Sending more is not.

## Where model output reaches a vendor, and what stops it

Only two values the model produces travel to a vendor: the search `query`,
which is free text by design, and `userLocation`.

`userLocation` passes two checks. The synthesizer nulls anything that is not
two characters and uppercases the rest; the request schema then rejects
anything failing `/^[A-Z]{2}$/`. It was `.length(2)`, which accepted `zz` and
`Z9` — shape without membership.

Everything else the model emits — the country list, the headcount bounds, the
decision-maker titles — either filters records we already hold or is a field
the vendor genuinely accepts as free text.

Apollo sends only two of its nine declared fields, both correctly typed, and
its schema is `.strict()` so an unknown field cannot leave.
`person_seniorities` and `organization_num_employees_ranges` have fixed
vocabularies at Apollo's end and are declared as plain strings here. They are
unused today; typing them properly is owed before anything fills them from a
model.

## Fixtures are captured, not written

A mock that returns an invented shape proves only that our code handles our own
imagination. That is precisely how several defects shipped this week: the
fixtures were written from documentation, the documentation was wrong, the
tests passed, and the feature was dead.

`test/exa.spec.ts` fed the parser a result shaped like this:

```
{ url, title, publishedDate }
```

A real result carries:

```
{ id, url, title, publishedDate, author, image,
  entities: [{ id, type, version, properties: { ... } }] }
```

`entities` was missing entirely — the one field the whole company pipeline
reads. Entity parsing could have broken without a single test noticing.

`test/fixtures/` now holds verbatim captures:

| File | What it is |
|---|---|
| `exa-search-company.json` | a real `/search` response, `category: "company"`, three results |
| `exa-agent-run-completed.json` | a real completed agent run |
| `exa-agent-run-person.json` | a real agent run returning a contact with a cited source |

`test/vendor-fixtures.spec.ts` runs the real parser over them.

**A fixture has to be captured with the request the code actually sends.** The
first agent capture used a different `outputSchema` than the production builder
sends, so it exercised a contract we do not use. It was recaptured with
production's own nine fields. A fixture from a different request is as
misleading as an invented one.
