# Hook quality and BrightData posts probe

68 verified buyers (32 Aris, 36 Ondato) from `ref/reference.json`. Each carries a `hook`
object captured by the verifier's web read at zero extra cost. All 68 had a hook; none
was null.

## Part A — free-tier hook quality

One batched `llm()` call per seller, MODEL_STRONG json, closed-set label on the hook
quote text.

| quality | count | share |
|---|---|---|
| specific_event | 30 | 44.1% |
| generic | 24 | 35.3% |
| role_statement | 14 | 20.6% |
| none | 0 | 0% |

Per seller: Ondato 18/36 specific_event (50%), Aris 12/32 (37.5%).

Freshness (`hook.date`): 37/68 (54.4%) within 180 days; 6/68 have a hook with no date;
0/68 have no hook.

Five verbatim specific_event hooks: Dan Kim (Airwallex) "I'm joining Airwallex to connect
programmable money and AI agents..."; Zach Garman (Arq) "A huge day and a new era - ARQ is
here"; Adam Zadikoff (Kraken) "I'm hiring some eng talent to build some new mobile
products."; Syed Sibgatul Ahsan (MoonPay) "I'm starting a new position as Director,
Product Operations at MoonPay!"; Cindy (Xinqi) Zhao (Airwallex) "Thrilled to partner with
Google Cloud to help define the future of agent payments...".

Cost: $0.0301, labelling only. The capture itself is free.

## Part B — BrightData posts, paid tier

Ran `brightdataByUrl` serially, 400ms apart, on the 38 people lacking a specific_event
free hook, spread across both sellers and 19 of 20 companies. Found 30/38 (78.9%) rows; 21
had activity. One MODEL_FAST call classified each newest post: 7 on_topic_for_icp, 6
company_news, 5 personal, 3 none. Cost $0.0754 ($0.075 rows, $0.0004 classify).

## Part C — the answer

- Free verification alone gives a usable hook for 30/68 (44.1%) of verified buyers, at
  $0.001 per usable person, with no cost beyond this labelling.
- BrightData, run only on the 38 without one, added 7 more usable on-topic hooks (18.4%
  of that pool, 10.3% of all 68). Combined: 37/68 (54.4%) usable, $0.00285 per usable
  person across both tiers.
- **Verdict**: store the free hook for every verified buyer by default; `verify()`
  already produces it free. Run BrightData only as a top-up on the ~56% left with a
  role_statement, generic, or no hook: it converts about 1 in 5 of those, the rest have
  no activity or post off-topic. Not worth a default second pass on everyone.

`ledger('HOOK').spent()`: $0.1056 of the $0.60 cap.
