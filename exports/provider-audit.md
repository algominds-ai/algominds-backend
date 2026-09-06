# Provider options: sent vs available (audit on p2/screen)
- Company search (candidates.ts buildSearchRequest): query, category company, type fast, numResults 100, userLocation, excludeDomains. Unused: contents (moot for company category).
- Company proving (proof.ts provingRequest): numResults 3, type fast, includeDomains, startPublishedDate, contents.text 10000, highlights. Unused: excludeDomains (fallback search can return a personal LinkedIn page), maxAgeHours, livecrawlTimeout.
- Homepage read (homepages.ts): maxCharacters 4000, livecrawl "fallback" (deprecated; maxAgeHours is the current form).
- Person roster (clay.ts buildFilters): company_identifier, seniority levels, job_title_keywords. Unused: location filters; the filters-discovery endpoint; no keyword fallback when a band returns zero.
- Person verify profile read (verify.ts profileOpinion, 8000 chars) and authority quote (contents.ts quoteOnPage): NO freshness options; ExaContentsOptions has no maxAgeHours field. Likely cause of UNKNOWN verdicts on real executives (stale/empty cached LinkedIn page).
- Cost: /contents billed flat per page; fresh crawl costs latency, not dollars.
- Context caps: description 600, homepage 4000, contents 10000, profile 8000: freshness/coverage limits before length does.
Changes in flight (p2/fresh): maxAgeHours 0 + livecrawlTimeout on the two verification reads; homepage uses the current option; excludeDomains linkedin.com on the fallback proving search.
