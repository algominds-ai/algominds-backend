# Exa agent output schemas and evidence

Keep the vendor request schema simple and validate the response at the boundary. Company requests are built in `src/core/companies/agent-search.ts`; people research requests are built in `src/core/people/research.ts`. Shared request transport and terminal cost parsing live in `src/core/providers/exa/agent.ts`.

The company request removes the generated `$schema` declaration and keeps regex-based validation out of its vendor-facing fields. Earlier probes returned both malformed and fabricated responses under different schema encodings; those observations do not establish that one metadata field alone caused fabrication.

Company discovery allows fewer companies than requested and must not invent rows to satisfy an array length. People research has a fixed input set, so it returns one decision for each supplied ID, including rejected and unresolved people. Missing, duplicated, foreign or malformed IDs remain explicit coverage failures.

A schema-valid completed run is not proof of correct output. The people Agent owns the final semantic decision: it must check canonical profile identity, corroborate current employment and resolve conflicting roles before returning verified. Its `roleEvidence` contains a separate public URL and an exact quote naming this person in their current role; generic company pages and the person's self profile cannot satisfy that contract. Runtime code validates response structure and distinct URLs and stores the evidence. Independent evaluation reads the actual sources outside production; it must not treat provider-reported quotes as fetched text. See `people-method.md` for that contract.

Retain raw requests, responses, terminal provider cost and settlement state. Fast completion is a reason to inspect the output, not an automatic rejection or a success claim. Unexpected billing and unavailable terminal charges must remain visible in the run evidence.
