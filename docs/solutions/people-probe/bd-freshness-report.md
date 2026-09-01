# BrightData adversarial probe — is the 115M-row dataset a safe base?

Spend, network calls I actually made: BrightData ~$2.36 (939 records drained:
harbor-msp 206, centre-technologies 288, ntiva-inc- 445, plus 6 cheap counts).
Exa $0.14 (20 searches). All calls after the team's live-quota exhaustion (HTTP
000 hangs, snapshots stuck "building") are marked unknown, not reported as data.
Fronts 3 and 4 below were then redone OFFLINE from the ten rosters already on
disk (bd-aris.json) — no further BrightData calls — at the team's direction.

## 1. Staleness
No row carries a collection date in the documented 46-field schema. An
undocumented `timestamp` field exists on every row from the search endpoint.
Across three companies (n=206/288/445) it skews very fresh: median 2 days,
65–90% under 7 days, tail to 423–606 days for 2–6% of rows. Meaning unconfirmed.
Ground truth beats the field: 20 Harbor IT people with a real "Present" title,
checked against Exa's independent workHistory, came back 20/20 (100%) still
there. Caveat: only covers the 26% of rows with a usable title.

## 2. Completeness
Harbor IT: LinkedIn's own page says 51–200 employees; BrightData returns 206,
already past that ceiling — not under-covering there. Cyber Salus: LinkedIn
says 11–50; BrightData returns 21, plausible. Kraken: the slug find-companies
stored (kraken-exchange) returns 0 — a silent, error-free total miss.

## 3. Waste and masking bias — offline, pooled across ALL 10 Aris rosters (1,527 rows total)
Structured (real "Present" title): 525/1,527 = 34.4%. Junk (masked/blank/"All
Employees"): 445/1,527 = 29.1%. Headline-only (a guess, not a verified role):
557/1,527 = 36.5%. Per-company junk rate ranges 0–34% (worst: centre-technologies
33.7%, das-health 24.6%, harbor-msp 32.0%; best: etrepid 10%, newboldtech 13.6%).
Seniority bias — pooled, not per-company: senior share among structured rows
= 45/525 = 8.6%; senior share among masked/headline-only rows = 52/557 = 9.3%.
Essentially identical. Per-company direction flips: 4 of 10 companies show
masked rows MORE senior, 4 show structured rows MORE senior, 2 are a wash. This
is a well-powered null result — no systematic seniority bias in masking, across
1,527 people. The billing exposure is real regardless: BrightData charges per
row returned, so the 29% pure-junk share is paid at full price with zero
recoverable signal, inflating effective cost per usable person 3–4x the
$2.50/1000 sticker on the two companies I costed directly.

## 4. Identity traps — 10 companies, offline
Only 1 of 10 shows material sibling-brand contamination: Harbor IT, 22/206
(10.7%) rows match the harbor-msp filter but carry a different
current_company_name (14 "Harbor Networks", 8 "Boston Wireless").
`slugsSeen` surfaces the real acquired/sibling slugs (harbor-networks,
boston-wireless, new-england-network-solutions, harborshield-cybersecurity,
zagtechservices) — all confirmed real Harbor IT acquisitions by web search.
The other 9 (centre-technologies, frsecure, cyberlinkasp, newboldtech, etrepid,
cyber-salus, evergreen-holding-company, evergreen-services-group, and
das-health at 0.8%) show 0% or near-0% mismatch. The trap is real but rare —
tied to a company's own acquisition history, not a generic dataset defect. The
reverse case (current employees still tagged under an old acquired slug,
invisible to a single-slug filter) could not be measured — it needs a live
count against a slug not already on disk, and the account's quota was
exhausted before I could run it. Marked unknown, not reported.

## 5. Availability — a new failure mode, as bad as the other two
Independently confirmed by the team: identical search requests that returned in
250ms twenty minutes earlier came back as HTTP 000 (no status, no body, no
retry-after) after a 30-second hang; the snapshot endpoint separately queued a
job in "building" for 25+ minutes with no progress. A client that treats a
timeout as "zero rows" cannot tell that apart from Kraken's genuine dead-slug
zero. That is now two independent, unlogged ways this vendor returns a silent,
plausible-looking empty roster.

## Honest ceiling
Say: "For a clean, single-brand company, BrightData returns a same-week roster,
but under an outage or a stuck job it fails silently as an empty result, and
only about a third of rows arrive with a real title."
Never say: "This dataset reliably gives a complete, current roster of any
company's employees" — a wrong slug, a rolled-up brand, or a quota hang all
produce the same convincing zero.

**Verdict:** Not safe to build on unfiltered, and not safe to build on without a
timeout-vs-empty distinction in the client. Freshness held up on ground truth;
completeness, identity resolution, and availability did not — and per-row
pricing punishes the exact filtering fix that would solve the masking problem.
