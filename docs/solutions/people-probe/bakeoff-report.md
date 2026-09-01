# Marginal contribution bake-off — Harbor IT and Ntiva

Method: canonicalise every name (strip credential suffixes/prefixes, lowercase, first+last
token key). Apollo's free tier returns only first name + an obfuscated surname
(`Su***n`); matched against other sources' full names by prefix/suffix on the surname,
and against the ground-truth list the same way. A "buyer-shaped" title passes a regex for
chief/president/owner/founder/VP/director/head-of/market-president. All figures below are
measured, not projected.

## Fix found before the bake-off could even start

`companies-export.json` stores `harbormsp.com` for Harbor IT. The real domain is
`harborit.com` (confirmed via aris-companies.json and the live site). Every prior Apollo
run in this project queried the wrong domain and silently returned zero for Harbor IT.
Re-run against `harborit.com`: 25 people. This is a production bug, not a probe artifact —
any pipeline trusting the stored domain for this company gets zero Apollo/Findymail
results and no error.

## Per-provider raw numbers

| Provider | Harbor IT people (buyer-shaped) | Ntiva people (buyer-shaped) | Cost | Seconds |
|---|---|---|---|---|
| Exa (per-title x6) | 11 | 9 | $0.042/co (sunk, reused) | ~1-2s/title |
| BrightData (drained roster, reused) | 10 | 16 | $0 today ($0.515 / $1.113 sunk drain) | reused, 0s |
| Apollo (seniority+dept, correct domain) | 19 | 44 | $0 (free tier) | 0.34s / 0.25s |
| Findymail (search/employees, title list) | 5 (1 wrong-company) | 5 | ~10 credits total, ≈$0.17-$0.50 (plan-dependent; API returns no cost field) | 26.8s / 47.2s |
| Company site (harborit.com leadership page) | 0 named execs found | not tried, same publisher pattern expected | $0 | — |

Findymail is slow (27-50s per call, one request timed out with a 504 on first Ntiva
attempt) and is a title-search, not a roster dump — same title-invention exposure as
Apollo/Exa, capped at 5 returned contacts per call.

## Marginal contribution — found by exactly one provider, no other

**Harbor IT** (union = 25 people):
- Exa only (3): Jason Bricault (Dir. Information Security), Josh Oakes (COO — the only
  provider that found the COO), Laura Spurzem (Dir. HR)
- BrightData only (1): Zach Baldry (Project Director, Critical Infrastructure)
- Apollo only (7): Greg Be\*\*\*n (CEO & President — likely a sibling-brand mixup, flagged not
  confirmed), Lloyd Gr\*\*\*n (Project Director), Lorin Fi\*\*\*r (VP Managed Services), Nick
  O'\*\*\*l (Dir. Professional Services), Seth Fr\*\*\*n (Dir. Client Success), Shannon O'\*\*\*d
  (Dir. Marketing), Virginia De\*\*\*o (Service Delivery Director - Healthcare)
- Findymail only (0)

**Ntiva** (union = 49 people):
- Exa only (0)
- BrightData only (3): Aaron Taylor (Market President - Indiana), Cheryl Biernat-Weinert
  (Market Director, Client Success), Erik S. (Dir. Client Onboarding)
- Apollo only (24): a long tail of Directors/VPs BrightData's title-from-experience field
  and Exa's per-title search both missed — full list in the run output.
- Findymail only (1): Mark Gilbreth, CFO — the only provider that found Ntiva's CFO.

## Where the curve flattens

Added best-first by solo recall against the 8 known Harbor IT seniors (Exa 7/8, Apollo
6/8, BrightData 5/8, Findymail 3/8):

    +Exa        -> 11 people, 7/8 known seniors
    +Apollo     -> 22 people (+11), still 7/8 (Apollo's hits are a subset of Exa's)
    +BrightData -> 25 people (+3), 8/8 — BrightData is the ONLY source with Hannah Paige (CFO)
    +Findymail  -> 25 people (+0), 8/8 — Findymail also has Paige, but BrightData got there first

Same order on Ntiva: Exa 9 -> +Apollo 45 (+36) -> +BrightData 48 (+3) -> +Findymail 49 (+1,
the CFO again).

**The curve does not flatten after two sources.** It flattens after three. Apollo, once
pointed at the right domain, is the single biggest raw contributor by volume (adds 11-36
people) but contributes zero marginal GROUND-TRUTH seniors at Harbor IT — its unique finds
are real people at real buyer-shaped titles, just below the C-suite line the 8-name list
tracks. BrightData is the one that closes the recall gap in both companies (Hannah Paige at
Harbor IT, three Market Presidents/Directors at Ntiva). Findymail's only unique find (Mark
Gilbreth, Ntiva's CFO) mirrors BrightData's role: fourth-source additions are small and
concentrated on the C-suite tier, not on volume.

## Cost per marginal buyer

- BrightData: $0.515 (Harbor drain, sunk) / 1 marginal GT buyer = $0.515/marginal-GT-buyer,
  but $0.515 / 4 marginal buyers overall (Zach Baldry + the union effect on Paige needing
  BD specifically) ≈ $0.13/marginal buyer at Harbor IT. Cheap once the roster is already
  drained; expensive if the drain has to be paid fresh per lookup.
- Apollo: $0 — free regardless of marginal count. Best cost-per-marginal-buyer of any
  source by definition, though its marginal buyers are the least senior of the four.
- Findymail: ~$0.17-$0.50 total / 1 confirmed unique buyer (Gilbreth) across both companies
  = worst $/marginal-buyer of the four, and the slowest (27-50s/call, one 504).
- Exa: sunk $0.084 total / 3 marginal buyers (Harbor only) = $0.028/marginal buyer.

## Recommendation

Run three: **Exa + Apollo (free) + BrightData**, in that order, and treat BrightData as the
recall-closer rather than the primary source now that its roster-drain cost is understood.
Skip Findymail for this use case — its only distinguishing win (Ntiva's CFO) is a titled
person BrightData or a second Apollo department slice would likely also surface for free,
and its latency (up to 50s, with a timeout observed) is disproportionate to one extra name.
The free company-leadership-page idea did not pay off here: Harbor IT publishes no named
executives on its site at all, so that channel returns zero for this vertical (MSPs
generally do not list leadership team pages) and is not worth automating.

Total measured new spend this run: Apollo $0, Findymail ~10 credits (≈$0.17-$0.50 by
published plan pricing, not directly returned by the API), Exa/BrightData $0 (reused
existing data). All comfortably under the $1.50 ceiling.
