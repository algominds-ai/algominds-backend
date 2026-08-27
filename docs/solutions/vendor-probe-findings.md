# Vendor probe findings, 2026-08-27

Every claim here came from a live call with real keys. Where it contradicts vendor
documentation, the live result is authoritative. Total probe spend: about $0.09 on Exa,
2 Apollo credits, ~5 Findymail credits, $0.0000018 on the gateway.

## Exa

### `/search` replaces the Agent API for both capabilities

| | Agent API | `/search` |
|---|---|---|
| Latency | ~20 s at `minimal` | 1–4.5 s |
| Cost, 3 people | $0.012 | $0.010 |
| Hard filters | none | dates, domains, category, includeText |
| Result | identical | identical |

One `/search` call does search, page fetch, and structured extraction together.

### People, one call

```
category: "linkedin profile", type: "keyword",
contents.summary.schema: { fullName, currentTitle, currentCompany, location }
```

Returns, for 3 results at $0.010 in 4.5 s:

```
{"fullName":"Max Freeman","currentTitle":"SVP of Sales","currentCompany":"Ramp",...}
{"fullName":"Elliot Silverstein","currentTitle":"VP of Sales (Current)","currentCompany":"Ramp"}
{"fullName":"Kyle Bastien","currentTitle":"Director, Revenue Enablement","currentCompany":"Ramp"}
```

`currentCompany` is the employment signal. No separate verification call is needed.

With `contents.text` the same call returns the full profile body: headline, location,
connection count, About, and an Experience section.

### Companies, two shapes

`category: "company"` is semantic-only. The API rejects date filters explicitly:

> The company category does not support the following filters: startPublishedDate.
> These categories use dedicated indices that only support semantic search.

So there are two distinct searches:

- **ICP shape** — `category: "company"` plus a summary schema. Returned ZeroSettle (YC W26,
  Pre-Seed, SF), Copperlane, Cranston AI, Sava, Anchor. $0.012 for 5.
- **Timely signal** — no category, plus `startPublishedDate`. Returned String
  "We're hiring a Founding GTM Lead" (2026-08-10) and SkillDock (2026-08-13). $0.012 for 5.

`startPublishedDate` removes stale evidence at the source rather than in the gate.

### Grounding is per row, not per field

Documentation shows `structured.companies[0].sourceUrl`. The API returns:

```
field: "structured.companies[0]"   confidence: "high"     citations: 2
field: "structured.companies[1]"   confidence: "medium"   citations: 2
```

`confidence` is populated and usable. A per-field path matches nothing.

### A URL field need not share a domain with its citations

Row 0 was Ripple with `sourceUrl` on linkedin.com while its citations were `aba.com` and
another unrelated host. A strict domain match between a field value and its citations
rejects legitimate rows.

### Summaries echo the query when they find nothing

Two company rows returned `signal` equal to the query string verbatim. A field whose value
matches the query text is a fabrication, and the gate must reject it.

### Costs and behaviour

`minimal` effort Agent run: $0.012, all in `search` (3 searches), `agentCompute: 0`.
`/search`: $0.007 for 2–5 results, $0.022 for 25. Summary adds ~$0.001 per result.
An unknown `category` returns an empty result set at zero cost, with no error.

## Apollo

**People Search is free and works.** 0 credits. Live limits: 200/min, 6,000/hour,
50,000/day. Returns `first_name`, `last_name_obfuscated` (`Fr***n`), `title`,
`organization.name`, `has_email`, `has_direct_phone`, `last_refreshed_at`, `id`.

It does **not** return a LinkedIn URL, and the organization carries no `primary_domain`.
So search output alone cannot feed an email finder.

**Enrichment charges a credit and returns nothing usable:**

```json
{"credits_consumed":1,"matches":[{"id":"...","linkedin_url":"...","organization":{"name":"Stripe"}}]}
```

No email, no `email_status`, no `employment_history`, on a healthy authenticated key.

**Unknown filter keys are silently ignored.** `totally_made_up_filter` returned the full
unfiltered count for the domain. A typo means no filtering, with no error. Validate filter
names locally with a strict schema.

Exact `person_titles` matching is narrow: "VP of Sales" at one domain returned 1 result,
while `person_seniorities` plus `person_department_or_subdepartments` returned 85 and 1,030.

## Findymail

Finds email by name plus domain, and by LinkedIn URL. Both work:

```
linkedin.com/in/maxwellfreeman  ->  mfreeman@tryramp.com    Max Freeman        SVP Of Sales
linkedin.com/in/esilverstein    ->  esilverstein@ramp.com   Elliot Silverstein VP Of Sales
```

Balance at probe time: 327,654 email credits, 374,780 verifier credits.

The two search modes can disagree. For the same person, name-plus-domain returned
`patrick@stri.pe` while LinkedIn lookup returned `patrick.collison@arcinstitute.org`.

**The verifier is not reliable alone.** Two invented addresses at one domain gave opposite
answers, and the response carries only `email`, `provider`, `verified` — no catch-all flag,
no confidence. `verified: true` cannot be the sole sendability gate.

## BrightData

Works, with the token from 1Password; the one in `.env` had expired.

Trigger returns a `snapshot_id`; the snapshot was ready in **7.3 s** for one profile and
69 s for 56. The record carries 34 fields including `current_company`, `experience`,
`education`, `about`, `city`, `followers`.

It cannot discover people — a LinkedIn URL is required as input. The billing endpoint
returns 403 for this token, so the live-trigger price stays unknown; only the $0.0025/record
marketplace tier at a $250 minimum is published.

## Cloudflare AI Gateway

**Cost is returned inline**, contradicting the documentation:

```json
"usage": { "prompt_tokens": 11, "completion_tokens": 5, "cost": 1.78e-06,
           "cost_details": { "upstream_inference_cost": 1.78e-06,
                             "upstream_inference_prompt_cost": 8.8e-07,
                             "upstream_inference_completions_cost": 9e-07 } }
```

Response headers confirmed present on every call: `cf-aig-model`
(`deepseek/deepseek-v4-flash-0731`), `cf-aig-provider` (`openrouter`),
`cf-aig-cache-status` (`MISS`), plus `cf-aig-log-id`, `cf-aig-request-id`,
`cf-aig-trace-id`, `cf-aig-event-id`, `cf-aig-step`.

The dynamic route resolves to a concrete model, so attributing cost to a configured id
would be wrong.

Base URL in use is a custom domain: `https://gateway.algominds.ai/compat`.
Routes: `dynamic/brain-reasoning`, `dynamic/brain-worker`.

## OpenRouter

`GET /api/v1/key` needs no extra setup and returns a live budget: `limit: 500`,
`usage: 20.56`, `limit_remaining: 479.44`. Usable as a spend guard.

Model prices are no longer needed, because the gateway returns cost directly.

## Clay

No key exists in the environment. Untestable, and therefore out.
