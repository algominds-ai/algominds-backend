# Find people — end to end

```mermaid
flowchart TD
    subgraph entry["Entry — two ways in, one pipeline"]
        A1["POST /runs/:runId/people<br/>companies come from the run's ICP"]
        A2["POST /people<br/>{ icpId, domains[] }"]
    end
    A1 --> B
    A2 --> B
    B["Load ICP + buyer intent<br/><i>account profile + who buys (from onboarding)</i><br/>DB: icp"]
    B --> C{{"for each company"}}

    C --> S1
    subgraph company["one company"]
        S1["1 · IDENTITY<br/>Clay by domain → else by stored LinkedIn URL<br/>both empty → <b>unresolved, stop</b>"]
        S2["2 · RETRIEVE<br/>Clay senior bands ×8<br/>small MSP with no senior HR → + manager band (HR/recruiting)<br/><i>fallback: Exa people search</i>"]
        S3["3 · DEDUPE<br/>canonical LinkedIn URL → name key<br/>code only"]
        S4["4 · SELECT<br/>model returns ≤6 candidate <b>ids</b> + basis<br/>reads: ICP + buyer intent + roster rows<br/>never emits a title · empty is valid"]
        S5["5 · VERIFY — one Exa agent run, structured output<br/>{verdict, evidence_url, evidence_kind, quote}<br/>first-party / press evidence stands alone<br/>aggregator-only → people index as second opinion<br/>silence → <b>unknown, excluded</b>"]
        S6["6 · STORE<br/>person + every provider reply, raw, as evidence<br/><i>context is a separate API</i>"]
        S1 -->|resolved| S2 --> S3 --> S4 --> S5 -->|verified| S6
    end

    S6 --> P["PERSIST<br/>person: name, title, linkedinUrl, basis<br/>evidence (append-only): verdicts, evidence urls, quotes, raw provider replies"]
    S1 -.->|unresolved| E["company marked<br/>identity unresolved"]
    S5 -.->|unknown / contradicted| X["not shipped<br/>kept as evidence"]

    classDef prov fill:#eef,stroke:#88a
    classDef stop fill:#fee,stroke:#c66
    class E,X stop
```

## Providers, one line each

| provider | used for | not used for |
|---|---|---|
| Clay | identity + full senior roster with real titles (quota, ~free) | — |
| Exa agent, effort minimal | verification with structured output: verdict, first-party evidence — $0.012, ~20 s | retrieval ($0.225 for 4 people already in the roster) |
| Exa /search people | second opinion when the agent's evidence is aggregator-only · retrieval fallback | primary retrieval |
| Exa /search web + model | fallback verifier if the agent is unavailable | — |
| BrightData | the separate context API, not this pipeline | rosters (paid per row, hangs under load) |
| Apollo | — | anything by default (obfuscated surnames never resolve) |

## What the two entry points share

Both resolve to `(icp, buyerIntent, companies[])` and then run the same per-company pipeline
above. The run-ID route reads companies from the run; the domains route builds them from the
list. Nothing below "for each company" knows which door it came through.
