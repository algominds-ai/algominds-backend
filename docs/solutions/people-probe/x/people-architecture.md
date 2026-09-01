# Find people — internal architecture

Two diagrams. The first is the structure: which module does what, what data moves between
them, and where the code/model boundary sits. The second is the run: how one company moves
through Workflow steps, where each paid call lives, and where a run stops.

## 1 · Structure — modules, data, and the code / model boundary

```mermaid
flowchart LR
    classDef code fill:#e8f0fe,stroke:#4a6fa5,color:#111
    classDef model fill:#fff4e0,stroke:#c98a1b,color:#111
    classDef prov fill:#eafaf0,stroke:#3a9a5c,color:#111
    classDef store fill:#f3f3f3,stroke:#888,color:#111
    classDef stop fill:#fde8e8,stroke:#c0392b,color:#111

    subgraph WF["src/workflows/find-people.ts — WorkflowEntrypoint"]
        direction TB
        W0["open run<br/>resolve icp + buyerIntent<br/>resolve companies (run or domains)"]:::code
        W1["per company: step.do per paid call"]:::code
        W9["close run<br/>cost ledger → run.costDollars"]:::code
    end

    subgraph CORE["src/core/people — plain async functions, take env"]
        direction TB
        C1["identity.ts<br/>resolveCompany(company, env)<br/>→ { identifier, how } | unresolved"]:::code
        C2["roster.ts<br/>seniorRoster(identifier, env)<br/>8 bands, + manager band rule<br/>→ Candidate[]"]:::code
        C3["dedupe.ts<br/>canonUrl · nameKey<br/>→ Candidate[] with stable id, seenBy[]"]:::code
        C4["select.ts<br/>pickBuyers(icp, intent, candidates, env)<br/>model → ids + basis<br/>code copies name/title/url by id"]:::model
        C5["verify.ts<br/>verifyPerson(p, env)<br/>Exa agent, effort minimal, structured output<br/>{verdict, evidence_url, evidence_kind, quote}<br/>aggregator-only → people index second opinion<br/>→ verified | contradicted | unknown"]:::model
        C6["rows.ts<br/>toNewPerson · evidenceRowsFor<br/>raw provider replies stored unshaped"]:::code
    end

    subgraph PROV["src/core/providers — one object literal each"]
        direction TB
        P1["clay<br/>search/filters-mode + run<br/>company_identifier · seniority bands"]:::prov
        P2["exa/search<br/>category: people → workHistory"]:::prov
        P3["exa/search<br/>web + text contents<br/>fallback verifier only"]:::prov
        P4["brightdata<br/>datasets/search by linkedin_id<br/>on demand only"]:::prov
        P5["model.ts<br/>AI Gateway · require_parameters<br/>cf-aig-skip-cache · closed-set JSON"]:::model
        P6["exa/agent<br/>agent/runs · effort minimal<br/>structured output schema"]:::prov
    end

    subgraph DB["Postgres via Hyperdrive"]
        direction TB
        D1[("icp<br/>doc.description<br/>doc.buyer ← NEW at onboarding")]:::store
        D2[("run · round")]:::store
        D3[("company<br/>domain · linkedinUrl")]:::store
        D4[("person<br/>name · title · linkedinUrl · data.basis")]:::store
        D5[("evidence — append only<br/>verdicts · evidence urls · quotes ·<br/>raw provider replies · identity_how")]:::store
    end

    D1 --> W0
    D3 --> W0
    W0 --> W1
    W1 --> C1 --> C2 --> C3 --> C4 --> C5 --> C6 --> W9
    C1 -.->|"unresolved"| X1["company: identity_unresolved<br/>no people, no guess"]:::stop
    C5 -.->|"unknown / contradicted"| X2["not persisted as person<br/>verdict kept as evidence"]:::stop

    C1 --- P1
    C2 --- P1
    C2 -.->|"fallback"| P2
    C4 --- P5
    C5 --- P6
    C5 -.->|"aggregator-only"| P2
    C6 -.->|"context API, later"| P4
    C6 --> D4
    C6 --> D5
    W9 --> D2
```

**The boundary, drawn:** blue is code and decides what is *true* about a record — identity,
fields, dedupe, currency. Orange is the model and decides what a record *means* — is this a
buyer, does this page confirm the claim. The model never returns free text that code parses:
it returns candidate ids, or one label from a closed set. Green is a vendor call; each one
sits in its own Workflow step so a retry never repeats a paid call.

## 2 · Run — one company through the steps

```mermaid
sequenceDiagram
    autonumber
    participant WF as find-people workflow
    participant ID as identity.ts
    participant RO as roster.ts
    participant DD as dedupe.ts
    participant SE as select.ts
    participant VE as verify.ts
    participant CL as Clay
    participant EX as Exa
    participant M as model (AI Gateway)
    participant DB as Postgres

    WF->>DB: load icp.doc { description, buyer } · companies for run
    loop each company (batched, one step.do per paid call)
        WF->>ID: resolveCompany(domain, linkedinUrl)
        ID->>CL: c-suite band by domain
        alt rows
            CL-->>ID: identifier = domain
        else empty
            ID->>CL: c-suite band by linkedin company url
            alt rows
                CL-->>ID: identifier = linkedinUrl
            else empty
                ID-->>WF: unresolved → evidence(identity_unresolved) · next company
            end
        end
        WF->>RO: seniorRoster(identifier)
        RO->>CL: 8 senior bands, one call each (cap-safe)
        opt small MSP, no senior HR owner in roster
            RO->>CL: manager band, keywords HR / recruiting
        end
        CL-->>RO: rows { name, title, url, since }
        RO->>DD: dedupe → Candidate[] { id, ..., seenBy }
        WF->>SE: pickBuyers(icp, buyer, candidates)
        SE->>M: roster rows (id, title, band) + icp + buyer → JSON picks [{id, basis}]
        M-->>SE: ids only · unknown ids dropped · empty allowed
        loop each pick, ≤ 6 (one step per agent run)
            WF->>VE: verifyPerson(name, title, company)
            VE->>EX: /agent/runs effort minimal, schema { verdict, evidence_url, evidence_quote, evidence_kind, confidence }
            EX-->>VE: structured reply (~20 s, $0.012)
            opt evidence_kind is aggregator or linkedin
                VE->>EX: /search people "title at company" → workHistory (second opinion)
            end
            alt CONFIRMED on first-party or press evidence, or CONFIRMED and index agrees
                VE-->>WF: verified
                WF->>DB: insert person · evidence(verdict, evidence_url, quote, raw agent reply)
            else CONTRADICTED
                VE-->>WF: contradicted
                WF->>DB: evidence only (status contradicted)
            else
                VE-->>WF: unknown
                WF->>DB: evidence only (status unknown)
            end
        end
    end
    WF->>DB: close run · cost ledger
```

## 3 · The contracts between stages

| from → to | shape | who guarantees it |
|---|---|---|
| workflow → identity | `{ domain, linkedinUrl }` | company row |
| identity → roster | `{ identifier, how: "domain" \| "linkedin" }` or `unresolved` | code; Clay's empty array on a wrong domain |
| roster → dedupe | `Candidate { name, title, company, url, since, src }[]` | Clay row mapper |
| dedupe → select | `Candidate { id, ..., seenBy[] }[]` with stable ids | `canonUrl` then `nameKey` |
| select → verify | `Pick { id, basis }[]` ≤ 6, ids resolved to records by code | Zod on the model reply; unknown ids counted and dropped |
| verify → persist | `{ status, verdict, evidence_url, evidence_quote, evidence_kind, confidence }` with `status ∈ verified \| contradicted \| unknown` | the agent's closed-set reply; aggregator-only needs the index to agree; the quote must be on the page |
| persist → DB | `person` row only when `verified`; `evidence` rows always | append-only invariant |

## 4 · What is deliberately not in the default path

- **Apollo** — surnames obfuscated, never resolved to a person another source confirmed.
- **Exa agent for retrieval** — $0.225 for four people already in the roster. It is the verifier, not a retriever.
- **Any second round or planner** — recovered nothing at all seven companies where it fired.
- **BrightData rosters** — paid per row, a third of rows unusable, hangs under load.
- **String matching for meaning** — no regex decides a buyer, no word overlap confirms a page.
