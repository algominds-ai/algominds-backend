# The Exa agent output schema: `$schema` invites fabrication

2026-09-02. Every companies agent round returned `companies: null` in about 2.5 seconds. For Aris three of three runs were null; for Ondato one of one. A byte-identical replay returned fifteen invented companies with `example-*.com` domains and placeholder job ids. The last request that returned real companies was 2026-09-01 00:15 UTC with the same request encoding, so the change was on Exa's side.

## Six paid probes against production encoding

| Probe | Schema | Pattern | anyOf null unions | Companies | Seconds | Cost |
|---|---|---|---|---|---|---|
| experiment-1 | $schema | regex pattern | yes | 15 (fabricated: example-msp-*.com) | 15.8 | $0.10 |
| experiment-2 | $schema | regex pattern | yes | null | 3.5 | $0.10 |
| experiment-3 | $schema | none | yes | 15 (real: teksystems.com) | 106.1 | $0.10 |
| experiment-A | $schema | none | yes | 5 (real) | 9.6 | $0.10 |
| experiment-B | $schema | none | yes | 15 (real: with fiber) | 186.3 | $0.34 |
| aris-round1 (baseline) | none | none | no | 5 (real: secur-serv.com) | — | $0.10 |

The schema carries a `pattern` regex on `website` filtering social platforms. Experiments 1 and 2 sent it; 3 and A sent the schema but dropped the pattern; B and baseline do not show these fields. Removing only `$schema` still gave null. Removing only the `pattern` regex gave real names with a competitor and a duplicate. The fix was to drop `$schema` with one destructuring line in both request builders, leaving `pattern` on the parse schema on receipt.

## The fix

`buildAgentRunRequest` and `buildVerdictRunRequest` in `src/core/providers/exa/agent.ts` drop `$schema` via destructuring: `const { $schema: _schema, ...outputSchema } = z.toJSONSchema(...); return { outputSchema: z.json().parse(outputSchema), ... }`. The request schema uses plain strings with no `.regex()`, so Exa never sees a pattern; the regex checks run in the parse schema when the vendor's response arrives. The query asks for "up to N" rather than "exactly N" and bans inventing companies, dates, pages, or quotes with `HONEST_COUNT_RULE`. The schema caps the array with `maxItems`.

## The evidence guard

`src/core/companies/evidence.ts` calls `verifyEvidenceRows` for rounds whose plan demanded dated proof. It fetches every gated row's evidence page and rejects a row only when the page truly does not exist — a 404, a 410, or a host that does not resolve (`fetch:0`). Every other outcome (missing quote, non-2xx status, timeout, unsafe URL) keeps the row and records the check reason on `evidenceCheck` for the judge and read routes to see. The people path keeps its stricter rule: a failed check rejects outright.

## The rule for next time

Never trust a `schema_satisfied` agent run that finishes in seconds. A real search takes minutes. A fabricated list has templated names ("Example MSP Houston") and placeholder ids. Compare the request Exa stored against the last one that worked — `GET /agent/runs/{id}` carries what was sent. The pattern regex was removed from production on Exa's side; a schema change there is the first place to look when a run suddenly stops working.

## One run billed unexplained

Experiment-B shows `dataSources: { "fiber": 0.24 }` on a 15-company run at 186 seconds. No other run with fiber configured paid that charge. It was never repeated or explained.
