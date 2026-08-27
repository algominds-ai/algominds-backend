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
