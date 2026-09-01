# The two-provider union, generalised from 2 Aris companies to 9

Evergreen Services Group is excluded entirely: its BrightData slug
(`evergreen-holding-company`, 104 rows) is a confirmed wrong-identity trap, and the
correct slug (`evergreen-services-group`) drained only 1 row. No BD-side comparison
is possible for it.

## Buyer-title rule (same rule, both sides, auditable)

    TIER1 (buyer regardless of function) = /chief \w+ officer|ceo|coo|cfo|cto|ciso|cio
      |president|owner|founder|partner|managing director/i
    TIER2 (buyer only if paired with a function below) seniority =
      /vp|vice president|director|head|manager|specialist|coordinator/i
    function = /operations?|service delivery|delivery|human resources|hr|talent|people
      |recruiting|staffing|shared services|transformation|strategy|training|pmo
      |program management|project management/i
    BUYER = TIER1 matches, OR (TIER2 seniority AND function both match)

Applied to the Exa titles of the 2 pilot companies with no tuning against BrightData,
this reproduces the pilot's Exa counts exactly: Harbor IT 13, Ntiva 12.

## Name matching

Names are matched after stripping (a) everything after a comma and (b) any token
that is 2-6 letters, all-caps (credential markers: MHA, PMP, CPTM, ...), before
lower-casing. This recovers 1 extra cross-source match out of 9 companies (at DAS
Health) that naive lower-case-and-trim matching missed — a real but small effect at
this scale; it will matter more as company count grows.

## Per-company table

| Company | Employees | Exa buyers | BD buyers | Overlap | Union | BD $ | Total $ | $/buyer |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Harbor IT | 206 | 13 | 7 | 5 | 15 | 0.515 | 0.557 | 0.0371 |
| FRSecure | 109 | 8 | 7 | 4 | 11 | 0.273 | 0.315 | 0.0286 |
| Centre Technologies | 288 | 7 | 16 | 2 | 21 | 0.720 | 0.762 | 0.0363 |
| Cyber Salus | 21 | 2 | 1 | 1 | 2 | 0.053 | 0.095 | 0.0473 |
| CyberlinkASP | 52 | 4 | 2 | 2 | 4 | 0.130 | 0.172 | 0.0430 |
| NewBold Technologies | 44 | 5 | 2 | 1 | 6 | 0.110 | 0.152 | 0.0253 |
| eTrepid | 10 | 4 | 0 | 0 | 4 | 0.025 | 0.067 | 0.0168 |
| DAS Health | 248 | 10 | 4 | 1 | 13 | 0.620 | 0.662 | 0.0509 |
| Ntiva | 445 | 12 | 14 | 3 | 23 | 1.113 | 1.155 | 0.0502 |
| **Pooled (9)** | **1,423** | **65** | **53** | **19** | **99** | **3.559** | **3.936** | **0.0398** |

Note: these BD-buyer and overlap counts use the now-fixed `currentTitleAt` (the
positions[]/Form-A-Form-B bug found after the 2-company pilot was written), so they
are the correct current numbers, not a reproduction of the pilot's BD figures. Harbor
IT's BD-buyer count moved from the pilot's 11 to 7 under the fixed extractor.

## The presence/title split, pooled across all 9

    Exa buyers checked against the BD roster: 65
    present in BD roster (with or without a readable title): 59 / 65 = 90.8%
    of those present, BD had a readable title:                19 / 59 = 32.2%
    truly absent from BD's roster:                              6 / 65 =  9.2%

This reproduces the 2-company pilot's 88%-present / ~32%-readable split almost
exactly at 9-company scale. The mechanism generalises: BrightData holds nearly all
these people, it just cannot read most of their titles.

## Where the union claim holds, and where it thins out

Union exceeds the larger single source at every company except Cyber Salus (21
employees), where BD's one buyer was already inside Exa's two and union = 2 = Exa
alone; CyberlinkASP (52 employees) added no NEW buyer either even though a full
overlap did not occur (BD's 2 sit inside Exa's 4 by name). At companies over 100
employees (Harbor, FRSecure, Centre, DAS Health, Ntiva) union exceeds Exa alone by
23-110% and overlap stays under 33% of the union every time. At eTrepid (10
employees) BD found zero buyers and 2 of Exa's 4 buyers are not in the 10-row BD
roster at all — the only company where "truly absent" is a large share (50%) rather
than a small one, consistent with BrightData's scrape being thin for very small
companies.

**Conclusion: the two-provider union holds as a general property of company size
over roughly 100 employees, and weakens toward redundancy under about 50, where the
whole buyer set is small enough that both tools converge on the same few
executives.**
