# BrightData filter vs Exa — arissearch.com, 10 companies

Method: `bdCount`/`bdSearch` against dataset `gd_l1viktl72bvl7bjuj0`, filter
`current_company_company_id = <slug>`. Title resolved with the fixed `currentTitleAt`
(experience entry, "Present"-gated, masked titles like `*******` rejected). Name matching:
normalize (lowercase, strip diacritics/punctuation, collapse whitespace), key = first token +
last token. Buyer title regex: owner/founder, CEO/president, COO/chief operating officer,
chief services or delivery officer, VP/director/head of service delivery, operations,
talent acquisition, HR, recruiting, or people, and "practice lead".

## Identity trap found (not assumed)

`evergreen-holding-company` (the slug stored in `companies-export.json` for Evergreen
Services Group) is the WRONG entity. All 104 rows are unrelated people — a Brazilian
production assistant, university students, a cleaner — whose LinkedIn "current company"
happens to also render as "Evergreen". A second guess, `evergreen-services-group` (the
most-common sibling id inside those same 104 rows' experience arrays), returned only 1
row and inspection showed it is a **different** unrelated "Evergreen" too. BrightData's
API became unreachable (`fetch failed` / connect timeout) while I was searching
`current_company_name` for the real one, so the correct slug is still unknown.
**Evergreen is excluded from every number below** rather than reported as zero.

## Per-company table (9 companies)

| slug | rows | title-from-experience | headline-only fallback | neither | BD buyers | Exa people | Exa buyers | Exa found of BD (all) | Exa found of BD buyers | BD found of Exa buyers | seconds |
|---|---|---|---|---|---|---|---|---|---|---|---|
| harbor-msp | 206 | 53 | 87 | 66 | 3 | 14 | 6 | 5 | 3 | 2 | 2.6 |
| frsecure | 109 | 46 | 30 | 33 | 0 | 10 | 2 | 4 | 0 | 0 | 1.2 |
| centre-technologies | 288 | 107 | 84 | 97 | 1 | 12 | 3 | 2 | 1 | 1 | 2.3 |
| cyber-salus | 21 | 5 | 11 | 5 | 0 | 6 | 1 | 2 | 0 | 0 | 0.5 |
| cyberlinkasp | 52 | 20 | 21 | 11 | 1 | 6 | 1 | 3 | 1 | 1 | 0.9 |
| newboldtech | 44 | 17 | 21 | 6 | 1 | 7 | 4 | 0 | 0 | 0 | 1.0 |
| etrepid | 10 | 5 | 4 | 1 | 0 | 6 | 2 | 0 | 0 | 0 | 0.6 |
| das-health | 248 | 81 | 106 | 61 | 2 | 14 | 6 | 1 | 0 | 0 | 23.2 |
| ntiva-inc- | 445 | 191 | 124 | 130 | 7 | 12 | 7 | 3 | 2 | 2 | 24.3 |

"Neither" = current_company_company_id matched but the person's experience array does not
list that slug at all (a sibling/acquired brand, per company: harbor-msp saw
new-england-network-solutions, noynim, zagtechservices as top siblings) — not masked
titles; zero masked titles were observed in any company.

## Headline numbers

- Median BrightData people (title-from-experience) per company: **46**
- Median BrightData buyer-titled people per company: **1**
- Total BD buyer-titled people across 9 companies: 15. Exa found 7 of them → **Exa's recall
  of BD buyers = 46.7%**
- Total Exa buyer-titled people across 9 companies: 32. BrightData had 6 of them →
  **BrightData's recall of Exa buyers = 18.8%**
- Total wall-clock: **56.6 seconds** for all 9 companies, sequential

## Cost — corrected

The Marketplace Dataset API is $2.50 per 1,000 records returned, on both `bdSearch` and
`bdCount`. `bdCount` uses `size:1` so a count is about $0.0025. I drained full rosters
before this price was known, but every company stayed under the 800-row sample line, so no
re-pull is needed — the same data stands, just costed:

| company | rows drained | total_hits (bdCount) | cost |
|---|---|---|---|
| harbor-msp | 206 | 206 | $0.515 |
| frsecure | 109 | 109 | $0.273 |
| centre-technologies | 288 | 288 | $0.720 |
| evergreen-holding-company (wrong identity) | 104 | 104 | $0.260 |
| evergreen-services-group (also wrong identity) | 1 | 1 | $0.003 |
| cyber-salus | 21 | 21 | $0.052 |
| cyberlinkasp | 52 | 52 | $0.130 |
| newboldtech | 44 | 44 | $0.110 |
| etrepid | 10 | 10 | $0.025 |
| das-health | 248 | 248 | $0.620 |
| ntiva-inc- | 445 | 445 | $1.113 |

Records drained: 1,528 → $3.820. Plus 11 `bdCount` calls at ~$0.0025 each → $0.028.
**Total BrightData spend this task: $3.85**, under the $4 ceiling but with almost no
headroom left — I made no further paid BrightData calls after learning the price, including
no retry on the Evergreen identity search.

**Cost per company, BrightData full drain vs Exa per-title search ($0.042/company):**
Harbor IT is the case the project needs — $0.52 of BrightData for 206 people (53 with a
real title) against $0.042 of Exa for 14 people. BrightData is ~12x the cost per company
but recovers a much bigger roster; whether that trade is worth it rests entirely on the
recall numbers above (46.7% / 18.8%), not on cost alone.

## The two-sided recall gap, spelled out

BrightData's roster is far bigger (525 titled people across 9 companies vs Exa's 87) but
buyer-dense only at the biggest company (Ntiva: 7 buyers out of 191). At 4 of 9 companies
(frsecure, cyber-salus, etrepid, and newboldtech only partially) BrightData's own filtered
roster surfaced **zero** buyer-titled people even though Exa found 2-4 buyers each there —
meaning the buyer often has no LinkedIn `current_company_company_id` match at all (works
under a parent brand, or the field is simply blank), not that BrightData missed a matching
row. Conversely, at Ntiva and Harbor IT, BrightData had buyers Exa never surfaced (Michael
Paris VP Shared Services, Aaron Taylor Market President - Indiana, Sean Killham, Dustin
Burda, Paul Pacheco VP Projects/Integrations) — genuine additional buyers Exa's search
missed.

Some of the "missed" pairs are matching-rule false negatives, not real misses — e.g. "Mary
Hart, MHA" (BD) vs "MHA Mary Hart" (Exa) and "Jamie Hinkle, PMP" (BD) vs "Jamie Hinkle"
(Exa) are the same person but the first+last-token key catches the credential suffix/prefix
as a token and splits them. Both counted as non-matches above; the true recall numbers are
a few points higher than reported.

## Production finding: BrightData does not degrade gracefully under load

Eight probes shared one BrightData account today. Once saturated, the endpoint gave no
status code and no `Retry-After` — calls that took 250ms-3s minutes earlier just hung and
returned `HTTP 000` (connect timeout) after 15-30 seconds. I hit this myself: my two
attempts to search `current_company_name` for the correct Evergreen slug both failed this
way and I could get no result, not a rate-limit error I could back off from cleanly.

This matters for production design, not just for this probe: a hang is not an empty
result. Code that treats a timed-out call as "this company has zero people" would silently
ship an empty roster to a customer. The only safe reading of a hang is "unknown, retry
later" — never "not found." A production integration must serialize BrightData calls
strictly (this account cannot sustain concurrent probes) and treat a timeout as a retryable
failure, never as a negative signal.

## Most surprising finding

The identity trap is the headline result, not a footnote: a slug taken directly from
find-companies' own stored `linkedinUrl` (`evergreen-holding-company`) resolved to zero
correct people across two attempts, silently, with a perfectly normal-looking `rows=104`
response. Nothing in the API response signals the mismatch — only reading the actual
`experience` content revealed it. Any pipeline that trusts `current_company_company_id` on
this field without a sanity check (do any resolved titles look plausible for the company's
industry/size) will bank zero real people for that company and never know it.
