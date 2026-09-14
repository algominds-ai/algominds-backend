# People discovery and verification

The engine finds direct buyers and adjacent relevant influencers at the supplied companies. Clay supplies the roster, the existing preliminary model selects candidates, Exa Search evaluates each selected person, and Exa Agent researches unresolved results.

## Flow and inputs

1. Resolve the request's companies and buyer. An explicit target overrides the captured buyer; a profile without a buyer remains roster mode. Preserve organization and profile ownership checks.
2. Request Clay's company roster without title or seniority filters. Paginate up to the configured ceiling. If retrieval is empty, rejected or incomplete, combine retained Clay rows with one Exa People roster fallback; that fallback requires a current role at the exact employer entity. Deduplicate canonical LinkedIn URLs.
3. Preserve the preliminary filter and ICP-derived seniority groups. All candidates in rosters of at most 25 remain eligible; larger rosters lose only clear unrelated matches. Missing or ambiguous decisions retain candidates. Adjacent influencers are eligible even without exact seniority or final signing authority.
4. For each selected candidate, send one Exa `/search` request: `type: deep`, `numResults: 10`, `contents: {highlights: true}`, and a required structured output schema. The query is `Verify this exact person as of YYYY-MM-DD. Context: {candidate: ...}`. No category, system prompt or forced-crawl setting is supplied. Search sees only the candidate record; company and buyer context remain in the prefilter and Agent fallback.
5. Validate the returned decision and evidence integrity. Save supported direct and adjacent people. Keep completed rejections in evidence. Send unresolved, missing or inconsistent outputs to the existing medium Agent lifecycle, in the existing seniority groups of at most ten.
6. Save Agent-supported matches. Retain unresolved or missing fallback decisions as `pending`, with a reason. Missing fallback decisions remain unprocessed/capped, even though the candidate is retained.

## What the fields mean

Search and Agent share the internal decision contract below. Only Agent receives the detailed research instructions and buyer rubric. Agent wraps results in a `people` array. Search returns ten flat fields in `output.content`: it omits `id` and uses nullable `roleEvidenceQuote` instead of `roleEvidence`, respecting its ten-property limit. Code binds the supplied candidate ID and derives the evidence URL from a returned page containing the quote, or the native grounding citations attached to `roleEvidenceQuote`.

| Required field | Meaning and use |
|---|---|
| `id` | Must identify the supplied candidate; foreign/duplicate Agent IDs are rejected. |
| `identityStatus` | Supported, contradicted or unresolved identity of this specific person. |
| `currentEmployerStatus` | Supported, contradicted or unresolved current operating employment at the supplied company. |
| `currentRoleStatus` | Supported, contradicted or unresolved current title at that company. |
| `buyerFit` | Direct, adjacent, unrelated or unresolved responsibilities relative to the supplied buyer rubric **and offer**. This is an inference, not proof of private purchasing intent. |
| `decision` | Verified, rejected or unresolved. It must agree with the status fields. |
| `name`, `title`, `linkedinUrl` | Corrected person fields, or null when unsupported. Verified requires all three. |
| `reason` | Explanation of factual conflicts and the responsibility-to-offer connection. Saved as the person's `data.basis` for delivered/pending people and retained in raw evidence for every returned decision. |
| `roleEvidence` | Actual HTTP(S) source URL and exact contiguous person/employer/role quote, or null. Required for verified decisions; stored in person evidence. |

Verified requires all three factual statuses to be supported, direct or adjacent buyer fit, corrected person fields and role evidence. Rejected requires a factual contradiction, or unrelated fit with supported identity/employment/role. An unknown fact cannot be converted into a clear buyer rejection merely because a retrieved title appears unrelated.

## Verification boundary

The providers interpret source content, current employment and chronology. Agent and the prefilter receive buyer context. Candidate-only Search does not; its `buyerFit` and buyer-related reason are therefore not a grounded evaluation against Ondato or another specific offer. The live audit must assess buyer fit separately. Small rosters retain every candidate before Search, so unrelated employees can reach this stage. Current professional profiles can support employment; an independently authored second page is no longer mandatory. Employer pages, named partners/events and original reporting remain preferred supporting sources. Generic company pages and unsupported contact-directory summaries are not sufficient. Additional concurrent employment alone is not a departure; missing work history alone is not a rejection.

Runtime code validates required fields, status consistency, candidate IDs, canonical profile URLs and credential-free HTTP(S) evidence URLs. A Search source comes from matching its quote against returned text/highlights, or from the provider's field-level `roleEvidenceQuote` citation when no excerpt matches. The latter preserves provider-reported provenance; it does not independently verify the quote. Search's native grounding is retained with the response; confidence labels do not establish truth or freshness.

Agent performs fallback research with the detailed factual and buyer criteria. Its supplied URL and quote are validated structurally and retained; the application does not independently fetch or match the Agent quote. There is no second semantic model or regex title gate.

Content retrieval uses Exa's default freshness behavior. This does not prove that indexed employment records are current. A schema-valid response or a matching quotation can still support an incorrect inference. The engine must qualify its returned people without operator correction.

## Identity, storage and API

Verified rows receive corrected name/title/profile and `data.buyerFit` distinguishing direct from adjacent. Pending rows retain retrieved identity fields and an explanatory basis; they do not grant verified status. Roster-only mode remains `roster`. Previously verified records are not downgraded by pending or roster observations. This flow writes no inferred aliases; names alone never authorize merging profiles. Retrieval dates and locations remain retrieval data.

Raw Search requests and normalized responses, native grounding, purchases, Agent replies and coverage are append-only run evidence. Person decisions use `verify-search`, `verify-agent` or `verify-pending`; synthetic pending evidence is attributed to the engine.

`GET /runs/:id/people` includes verified and pending rows for buyer modes. `peopleVerified` counts supported delivered profiles; the existing `peopleRoster` counter also counts retained pending observations in buyer mode. The endpoint remains scoped to the run's companies and allowed statuses, so historical records can appear for reused companies. Fresh organizations are required for clean measurements.

## Durability, spend and completeness

Companies and purchases remain sequential so cumulative spend writes cannot overwrite each other. Search reuses the durable purchase/bank steps. A reported Search charge is recorded even when its response is malformed. Unknown Search billing retains a $0.05 reservation in evidence and stops further purchases; it is not reported as a free failure. Known-cost malformed responses can use Agent fallback.

Agent start, polling, cancellation and settlement reuse the existing lifecycle. Each medium fallback requires $0.10 admission room. Ordinary paid steps retain their $0.05 admission allowance. The default configured $2 ceiling is shared across the entire workflow, with the account daily ceiling also enforced.

Missing, duplicate, foreign and malformed outputs stay visible in coverage. Completed unresolved decisions count as checked; missing fallback decisions do not. Budget exhaustion and provider pagination limits remain capped/incomplete. Finishing a finite roster never proves discovery of every employee.

## Evaluation

Use the independent people suite described in [Engine evals](eval.md). It runs
through authenticated API calls with fresh accounts, retains evidence and costs,
and provides focused prefilter and verification cases. Frozen company panels and
dated reference buyers live in `eval/people/cases.json`.

Past probes exposed stale-employer claims, missed eligible founders and disputed
buyer-fit labels. Their aggregate ratings are not proof of current engine quality.
Compare repeated runs on the same cases and independently inspect source evidence.
Hosted scheduling and production Hyperdrive still require deployment validation.
