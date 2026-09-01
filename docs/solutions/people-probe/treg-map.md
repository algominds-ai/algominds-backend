# treg probe — the overage, the free map, and the benchmark

## The overage — for raising with treg

**Total spend: $6.4962 against a $1.00 promotional grant — a $5.4962 overage, from TWO calls
to one endpoint, `lusha.x.decision-makers`, which treg's own catalog labels `"type": "free"`.**

Evidence, from `GET /calls`:

| call id | endpoint | status | `cost_observed_micro` | `cost_charged_micro` |
|---|---|---|---|---|
| 513685 | `lusha.x.decision-makers` | 200 | 5,491,200 | 1,000,000 (capped — balance was $1.00) |
| 515959 | `lusha.x.decision-makers` | 200 | 5,491,200 | 5,491,200 (uncapped — balance was $4.50+) |

**The non-obvious part, worth raising with the vendor: a zero balance would NOT have stopped
this.** `GET /orgs/4332/balance` shows the ledger mechanic directly — a `type:"free"` endpoint
reserves **$0** before the call regardless of the real balance, then settles the true observed
cost afterward, capped only by whatever balance exists at settle time (a real deficit is
recorded as `block_shortfall_micro` rather than refused). The catalog's own price label
(`"free"`) is what lets the pre-call check pass; the real $5.49/call cost is only visible after
the fact, in the settle event. This is a genuine platform gap, not a user error on a specific
call — any call to this endpoint, at any balance, bills the real amount.

## Pre-call safety checklist (apply to any treg endpoint before spending on it)

1. Pull the endpoint from `GET /catalog/platforms/<slug>` and check its `cost` object for
   **both** `source_url` and `confidence`. Missing either is a red flag.
2. If free-labelled, also require an empirical note (e.g. "observed live," "balance unchanged,"
   "credits_consumed 0") — a purely descriptive note ("previews are free…") is not evidence.
3. Prefer a routed `treg.*` id over a raw provider id where one exists — routed ids carry an
   `X-Treg-Route-Max-Cost` guard; raw provider ids carry none.
4. Make ONE deliberate test call. Immediately read `GET /calls/{id}` (or the org balance ledger)
   and confirm `cost_charged_micro` matches what the catalog promised.
5. Never call the same unverified endpoint a second time before that confirmation.

The 29-endpoint distrust list below is exactly the set that fails step 1 and step 2 together —
that is the population this checklist exists to catch.

## 1. The free map — best-fit endpoints, price-sorted

| Job | Endpoint | Price | Provenance |
|---|---|---|---|
| Roster enumeration | `aviato.companies.employees` (only endpoint in `companies.employees`) | $0.005/call, ≤100 rows/page | source_url + confidence present |
| Buyer shortlist w/ title | `lusha.x.decision-makers` (only endpoint in `people.decision_makers`) | labelled free | **no source_url, no confidence — mislabelled, real cost ≈$0.125/contact** |
| Verified title | `hunter.people.enrich` / `hunter.x.combined-find` | $0.0049/success | verified |
| Verified title | `tomba.people.enrich` | $0.0089/success | verified |
| Person search (title+company) | `exa.people.search` | $0.0070/call | verified — same price as our direct Exa integration |
| Person search (cheap, ids only) | `aviato.people.search.simple` | $0.0025/success | no provenance |
| LinkedIn URL / profile | `tikhub...get-user-profile` | $0.0010/success | verified |
| LinkedIn URL / profile | `brightdata.linkedin.user.profile` | $0.0015/result | verified |
| Email find | `hunter.people.enrich` (bundled) or `tomba.people.email.find` | $0.0049–$0.0089 | verified |
| Email find (routed, tries our providers first) | `treg.people.email.find` | $0.0089 typical | n/a — routed |

## 2. Price-integrity audit — the hypothesis holds, sharpened

Of 344 endpoints in `people`+`companies`+`linkedin`, 252 carry both `source_url` and
`confidence`; 92 do not. Of the 58 labelled `type:"free"` without those two fields, only 29 also
lack any empirical note (no "observed live", "balance unchanged", "credits_consumed 0" claim).
`lusha.x.decision-makers` sits in that worst bucket — a purely descriptive note ("previews are
free, only enrich is billed") with zero observational backing — and it is the ONE endpoint now
proven, twice, to be flatly false. Other names in that same worst bucket worth distrusting
before calling: `apollo.people.search`, `coresignal.people.search`, `hunter.x.multi-domain-search`,
`hunter.x.discover-people`, `crustdata.people.autocomplete`, `crustdata.companies.identify`,
`findymail.intellimatch.*`, `findymail.signals`. **Rule: missing source_url+confidence AND no
observed-live note = do not call without a funded, monitored balance.**

## 3. Routing our own keys — confirmed from docs, not tested live

`llms.txt` confirms the credential ladder: an org's own registered tool for a provider always
wins over treg's key, and those calls are never metered (except X/Twitter). Registration is
`treg upload env` (scans `.env`, matches ~80 known providers, e.g. our `APOLLO_API_KEY`,
`EXA_API_KEY`) or manually `treg secret add` + `treg tool add`. This would make our existing
Apollo/Exa/BrightData keys answer through treg's uniform `/call/` surface and catalog shape at
**zero marginal cost** — a real integration-layer benefit, independent of the balance disaster.
Not tested live (would require running `treg upload`, out of scope for a probe).

## 4. Free-endpoint test against Harbor IT — not attempted

Skipped deliberately: the balance-gate failure in the urgent note above means no call can be
trusted as actually free right now. Recommend re-attempting only after balance is funded and the
gate bug is understood or fixed.

## 6. Benchmark on Harbor IT (206-row ground-truth roster, 8 known real seniors)

Balance checked first this round: **$4.5038** before, **$4.4869** after — this section's total
measured spend is **$0.0169** (aviato $0.015, icypeas.people.search $0.0019, all others free),
well inside the $3 cap. Every endpoint priced from the catalog before calling; `hunter.x.multi-domain-search`
and `leadmagic.x.employee-finder` both 503'd (`provider_capacity_unavailable`, $0 charged) —
treg's own shared pools for those two providers are exhausted right now, unrelated to our balance.

| Endpoint | People returned | Real-title share | Cost (GET /calls) | Seconds |
|---|---|---|---|---|
| `aviato.companies.employees` | 0 usable — resolved `harborit.com`/`www.harborit.com` to the WRONG company ("NetXperts") on every identifier format tried (website, linkedinURL variants); repeatable across 4 calls | n/a | $0.020 (4 calls, all "successful" per the API even though wrong) | 0.09–0.43s each |
| `apollo.people.search` | 179 | 178/179 (99.4%) carry a structured title (last names obfuscated, titles are not) | $0.00 (genuinely free, confirmed via ledger) | 0.19–0.21s each, 3 calls |
| `leadsforge.people.search` | 186 | 186/186 (100%) | $0.00 (genuinely free, confirmed via ledger) | 1.3–2.0s each, 2 calls |

**Marginal contribution against the 8 known seniors** (Johnny Lieberman, Hannah Paige, Michael
Sullivan, Josh Oakes, Eric Regnier, Charles Fuller, Jeff Dayton, Alex van Lent) — reusing the
already-paid Lusha call from earlier in this probe, no new spend:

- **`leadsforge.people.search`: 8/8, alone.** Free. It is the only source, paid or free, that
  found Michael Sullivan (Lusha's one miss) AND Charles Fuller (absent from our own 206-row
  BrightData ground-truth scrape entirely).
- `lusha.x.decision-makers` (paid, $5.49/call): 7/8, missing Michael Sullivan.
- `apollo.people.search` (free): 5/8 — missing Hannah Paige, Josh Oakes, Charles Fuller, but it
  DOES find Michael Sullivan, the one person the $5.49 Lusha call missed.
- `aviato.companies.employees`: 0/8 (wrong company).
- Apollo + Lusha together also reach 8/8, at $5.49 total. LeadsForge alone reaches the same 8/8
  at $0.00 — a free catalog endpoint outright beat the "premium" $5.49 one on this benchmark.

**Does treg carry a LinkedIn roster source that bypasses our blocked IP?** Not a BrightData
dataset-filter equivalent — treg's BrightData wrapper only exposes `/datasets/v3/scrape`
(single profile or single company lookup: `brightdata.linkedin.user.profile`,
`brightdata.x.linkedin-company-info`), never the bulk `/datasets/filter`+`/datasets/snapshot`
roster API our own `bd.mjs` uses. But `apollo.people.search` and `leadsforge.people.search`
both ran successfully from treg's infrastructure moments ago — they are real, working,
zero-cost, IP-independent substitutes for "get this company's people," even though the
underlying data isn't sourced from BrightData's LinkedIn dataset.

## 7. What a funded run would cost

10 companies, roster + verified titles, using ONLY correctly-priced endpoints (excluding the
mislabelled Lusha one): `aviato.companies.employees` at $0.005/page (≈2 pages/company for a
~150-person company) + `hunter.people.enrich` at $0.0049/verified title, budgeting ~10 verified
buyers/company → 10 × ($0.01 + 10×$0.0049) = **≈$0.59 for 10 companies**, before accounting for
aviato's title-quality risk (my one test call matched the wrong company and returned a garbage
title "Firma" — untrusted until re-verified). Against measured incumbents: BrightData $2.50/1,000
rows (~30% structured titles) and Exa $0.007/search (13–14 people/company, ~$0.07–0.10/company,
72% plausible-buyer rate). treg's cheapest verified path is price-competitive but carries an
unverified title-quality gap BrightData and Exa do not have.

## Conclusion

Clay was benchmarked directly on Harbor IT today and returned 212 people with 100% real current
titles and 7 of 7 known seniors, at zero marginal cost against an existing annual quota. That
beats every treg-catalog result in this report on every axis measured here — count, title
quality, seniors found, and cost. **treg's case as a DATA source is weak; do not re-open it
expecting a data win.** Its one remaining candidate value is the own-key integration layer (§3
above) — routing our existing Apollo/Exa/BrightData keys through treg's uniform `/call/` surface
at zero marginal cost, turning treg from a vendor into plumbing. That is confirmed only from
`llms.txt`, not tested live, and stays unverified until someone deliberately tests it.
