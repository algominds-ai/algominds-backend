1. **(a) Yes for candidate testing; (b) only conditionally.** Use `maxAgeHours: 0` with `livecrawlTimeout: 10000` on verification reads. This requests live crawling, not proof that the published employment claim is current; measure crawl failures and end-to-end latency. Stale cache causing the earlier UNKNOWN verdicts remains a hypothesis. [Exa freshness documentation](https://exa.ai/docs/reference/livecrawling-contents)

   Billing is per page **per content type**, not per character; repeated reads still cost money. [Pricing](https://exa.ai/pricing?tab=api)

   Exclude LinkedIn where the requirement’s allowed source kinds exclude it—as Form3’s does. **Do not make that a universal proving exclusion:** another profile may legitimately permit LinkedIn. A company LinkedIn page does not satisfy Form3’s list either.

2. **Reuse the existing buyer-capture model call; no new synthesizer.** Bands supplied a broad roster cheaply; adding a planner was never inherently necessary. But ignoring named roles at retrieval now leaves a demonstrated coverage gap.

   Important correction: `resolveBuyer` is deterministic—it cannot interpret arbitrary prose without additional machinery. Capture retrieval keywords alongside the rubric during existing onboarding, then forward them.

   Add **one company-scoped keyword fallback when selection yields zero**, without the same restrictive seniority bands; adding another filter to an empty band cannot broaden it. Avoid arbitrary “under N” thresholds. Retain broad-pass candidates and local eligibility checks. Clay itself recommends title keywords and warns that seniority filters can exclude matches. [Clay guidance](https://university.clay.com/docs/finding-companies-and-people-in-clay)

   Zero-cost tests: stub empty/junk initial results, assert the exact fallback request, merge/dedupe, and verify no second fallback. This proves wiring—not Badoo recovery; only a live result proves that.

3. **Keep local bounds authoritative, send supported vendor filters, and tighten query wording where useful: rejecting 720 rows is computationally cheap but wastes paid retrieval capacity, while query text cannot enforce numeric bounds.**

4. **Yes—two screens costing approximately $5 combined, not $5 each, then one seven-profile draw.** Include only the scoped, tested provider changes; freeze before screening. Require five accepted companies, perfect delivered-person precision, ≥4/5 buyer coverage and existing time/cost gates. These provider changes do not resolve SteadyPay’s contract interpretation; freeze that policy too.


