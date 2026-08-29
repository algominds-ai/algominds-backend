# What the judge costs, what it buys, and why it stays on the reasoning model

The judge is the last stage of a company round. The filter and the gate refuse a
company on figures, and the judge refuses one on meaning. Every number here came
from calling the real gateway with rows a real Exa search returned, on
2026-08-29.

## The judge is the run, in time and in a third of the money

One Exa search of a hundred results takes about 0.4 seconds and costs $0.097,
flat. The judge over the candidates from that search costs this:

| Rows | Time | Cost | Output tokens |
|---|---|---|---|
| 10 | 15.7 s | $0.021 | 1,403 |
| 36 | 47.5 s | $0.075 | 5,131 |
| 100 | 103.9 s | $0.190 | 12,770 |

A round asking for twelve companies sends the judge 36 rows, so the round is
roughly 0.4 seconds of vendor and 47 seconds of judge. Asking for a hundred
companies sends it 100 rows, because `resultsPerRound` caps what one search
returns, so no round ever judges more than that. Three such rounds are five
minutes and $0.57 of judging.

Output tokens drive the cost, which is why the judge is asked for a reason only
when it refuses a row. That alone took a 36-row call from about 100 seconds and
$0.121 down to 43 to 72 seconds and $0.064 to $0.094, with the same verdicts.

## What it buys is the companies no figure can refuse

Of 36 companies that passed the headcount and country bounds for a profile that
excluded data vendors and agencies by name, the judge refused 15. Its reasons:

- `ocean.io`: a prospecting data platform, its core business is data
- `listkit.io`: describes itself as a B2B data provider
- `reachstream.com`: a B2B data platform
- `reveneer.io`: an outsourced sales agency, not a software subscription
- `outboundsalespro.com`: sales as a service, not a product

None of those can be expressed as a bound on a number. Without the judge they
reach the list, and a list of the seller's own competitors is worse than a short
list.

## A cheaper model was measured and refused

The worker model costs about a hundredth of the reasoning model and answers five
times faster. Against eleven companies hand-labelled as ones the profile
excludes by name, over three runs each:

| Model | Caught | Kept |
|---|---|---|
| reasoning | 8, 8, 8 | 20, 20, 19 |
| worker | 11, 5, 6 | 8, 25, 24 |

The reasoning model misses the same three every time. The cheap one caught
everything once and then let `leadiq.com`, `ocean.io` and `activeprospect.com`
through on the next two runs. Steady and wrong in a known way beats cheap and
different every time, so the judge stays where it is.

## Agreement between models is not a measure of quality

The first comparison scored the cheap model by how often it agreed with the
reasoning model: 77 per cent, which read as "near enough". Then the reasoning
model was run three times on the same rows and compared with itself:

```
run 1: kept 18   run 2: kept 20   run 3: kept 22
self-agreement: 81%, 82%, 91%
```

A model that agrees with itself 85 per cent of the time cannot be used as a
ruler for anything finer than 15 per cent, so the 77 per cent said nothing at
all. Only the hand-labelled answer key separated the two. Build the key first
when a model's judgement is the thing being measured.

The same non-determinism is the run's own: identical input, 18 to 22 companies
kept. A caller sees that as an eleven per cent swing in the size of its list,
for no reason it can see.

## Two ways the judge fails open

`judge.ts` keeps every row the gate passed when the model returns nothing usable
twice, on the reasoning that the gate's decision stands. Nothing requires the
model to return one verdict per row either, so a short or repeated answer drops
or duplicates candidates in silence. Both are recorded in
`docs/residual-review-findings/2026-08-29-codex-branch-review.md`.

## Verification

`test/judge.spec.ts` proves a kept row parses with no reason and a refused row
carries its reason to the caller. The measurements above are not in the test
suite; they came from probe scripts run against the live gateway and Exa, and
`docs/solutions/vendor-probe-findings.md` holds the standing rule that a live
result outranks the vendor's documentation.
