---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
created: 2026-08-30
type: feat
---

# feat: Seller context, evidence rules, and domain-to-ICP onboarding

## Summary

Five changes, all measured in session on 2026-08-30. Four are small edits to what
the Exa agent is told and what a row carries. The fifth adds onboarding: a seller
domain becomes a stored ICP description, written by one function that a signup
hook and an endpoint both reach through a Workflow.

---

## Problem Frame

`grep -r seller src/` returns nothing. The engine prospects without knowing who it
sells for, so it returns the seller's own customers. Its evidence rules bar the
freshest source it has. Its effort default is the slower-decaying one. Its rows
cannot say what kind of page proved them. And a profile can only be created by SQL
or by passing a prompt to `/companies/find`.

---

## Requirements

- **R1** The agent request carries the seller's domain, the customers it already
  names, and the competitor category described by who those competitors sell to.
- **R2** A LinkedIn post is admissible evidence; a `linkedin.com/in` member profile
  is not.
- **R3** The default agent effort is `medium`, in the instruction and in every
  code path that fills the field when the model omits it.
- **R4** `evidenceKind` reaches `CompanyRow`, the stored capture, and the API, and
  never reaches the judge.
- **R5** One function turns a seller domain plus an optional free-text note into a
  stored ICP description.
- **R6** That function runs on organization creation without delaying signup, and
  from a standalone endpoint for an existing account.
- **R7** An onboarding run is visible on the `/runs` surface and its cost counts
  against the account's daily ceiling.

**Out of scope, do not build:** per-account suppression list, per-day run-id retry,
parallel rounds, incremental publication-date windows.

---

## Key Technical Decisions

**KTD1. The seller lives on `IcpDoc`, not on a new table.**
(session-settled: user-approved — chosen over a `seller` table: the profile is
already the per-account document the synthesizer and the agent both read, and a
table with one row per organization is an abstraction with one implementation.)

**KTD2. Competitors are excluded as a category, never as a list of names.**
(session-settled: user-approved — chosen over passing the extracted competitor
names: measured, a name list made results worse. Brex's list held Ramp, Mercury,
Expensify, Amex, Coupa, Concur, Airbase and Divvy, so the agent moved to Payhawk,
Rippling and Pexcard. Samsara's moved to fillipfleet, hcss and getclue.)

**KTD3. `evidenceKind` is a label, never an input to keep-or-refuse.**
(session-settled: user-directed — chosen over feeding it to the judge: measured,
adding kind alongside quote and publisher dropped farm detection from 3/3 to 2/3.)
`judgePrompt` serialises the whole row with `JSON.stringify(row)`, so honouring this
needs an explicit exclusion, not an omission. See U3.

**KTD4. Onboarding runs as a Workflow, not `ctx.waitUntil`.**
(session-settled: user-approved — chosen over `waitUntil`: the measured run is 52
to 55 seconds with a live crawl, and CLAUDE.md states that nothing holds an HTTP
connection open waiting for a vendor.)

**KTD5. The auth hook is built in `createAuth`, not in `authOptions`.**
(session-settled: user-approved — chosen over putting it in `authOptions`: that
object is shared with the schema generator and has no `env`, and the hook needs the
Workflow binding.)

**KTD6. The onboarding run row opens after the ICP row is written.**
`run.icpId` is `notNull` and references `icp.id`, so a run cannot exist before its
profile. The workflow therefore checks the ceiling first, buys second, and writes
the ICP and its run row together in the final step. Chosen over relaxing the
foreign key, which would let a run point at nothing.

---

## Implementation Units

### U1. Carry the seller into the agent request

**Goal** The agent knows who it prospects for and stops returning that seller's
own customers.

**Requirements** R1

**Files**
- `src/core/synthesize.ts` — `IcpDocSchema` gains optional `seller`
- `src/core/companies/agent-search.ts` — `agentSystemPrompt`, `buildAgentRunRequest`
- `src/workflows/find-companies-agent.ts` — `AgentSearchInput` and the `agentSearch` closure, the only caller of `buildAgentRunRequest`
- `src/core/companies/index.ts` — `FindCompaniesDeps["search"]` and `FindCompaniesOptions`
- `src/workflows/find-companies.ts` — thread it from the loaded ICP
- `test/exa-agent.spec.ts`, `test/find-companies-agent.spec.ts`

**Approach**
1. `IcpDocSchema`: add `seller: z.object({ domain, customers: z.array(z.string()), competitorTest: z.string() }).nullish()`. `competitorTest` is one sentence describing who a competitor sells to — never a list of names, per KTD2.
2. `agentSystemPrompt` gains sentences naming the seller domain as never usable as evidence, the customers as already won, and the competitor test.
3. `buildAgentRunRequest` already takes `plan`, `count` and `today`; the seller is its fourth parameter, exactly on biome's `useMaxParams` limit.
4. Thread the seller from the ICP through `FindCompaniesOptions`, `FindCompaniesDeps["search"]`, and `AgentSearchInput` to the one call site in `find-companies-agent.ts`.
5. A profile with no `seller` produces the prompt exactly as it is today.

**Patterns to follow** `agentSystemPrompt` composes an array of sentences and joins
with a space. `today` was threaded the same way in an earlier commit; follow it.

**Test scenarios**
- With a seller, the prompt names the seller domain, each customer, and the competitor test.
- With no seller, the prompt is byte-identical to today's.
- An empty customer list adds no customer sentence rather than an empty one.
- `agentSearch` passes the seller through to `buildAgentRunRequest`.

**Verification** `bun run gate`.

### U2. Admit a LinkedIn post, and default the effort to medium everywhere

**Goal** Stop barring the freshest evidence source, and make `medium` the default
on every path rather than only in the instruction text.

**Requirements** R2, R3

**Files**
- `src/core/companies/agent-search.ts` — `agentSystemPrompt`
- `src/core/synthesize.ts` — `SYNTHESIZE_INSTRUCTIONS`, `toPlan`, `templatePlan`
- `test/exa-agent.spec.ts`, `test/synthesize.spec.ts`

**Approach**
1. The prompt states that a LinkedIn post announcing the event is good evidence because it is dated and written by the company or the person it concerns, and that a `linkedin.com/in` member profile is never evidence because it describes a person rather than recording an event.
2. `SYNTHESIZE_INSTRUCTIONS`: replace "Choose `low`" with medium as the default, carrying the measurement — medium gave median evidence age 32 days against low's 53, both fully inside their windows, at indistinguishable cost. The adjacent sentence "Raise it above `low` only when…" names `low` too and must move with it.
3. The two code paths that fill the field when the model does not: `toPlan`'s `output.agentEffort ?? "low"` and `templatePlan`'s hardcoded `"low"`. Both become `"medium"`. Without this the default holds only when the model explicitly names it.

**Test scenarios**
- The prompt admits a post and bars `linkedin.com/in`.
- The synthesizer instruction names `medium` as the default and no longer says "Choose `low`".
- A model output omitting `agentEffort` yields a plan whose effort is `medium`.
- `templatePlan`, the twice-failed fallback, carries `medium`.

**Verification** `bun run gate`.

### U3. Carry `evidenceKind` on the row, and keep it away from the judge

**Goal** A caller can tell a greenfield row from a displacement row, without
weakening the judge.

**Requirements** R4

**Files**
- `src/core/providers/exa/agent.ts` — `ExaAgentCompanySchema`
- `src/core/companies/agent-search.ts` — the eight-kind enum and `toExaResult`
- `src/core/providers/exa/search.ts` — `ExaResult`
- `src/core/companies/gate.ts` — `CompanyField`
- `src/core/companies/candidates.ts` — `toCompanyRow`, `CompanyMatch`, `toCompanyMatch`
- `src/core/companies/judge.ts` — `judgePrompt` excludes the field
- `test/exa-agent.spec.ts`, `test/companies.spec.ts`, `test/judge.spec.ts`

**Approach**
1. Mirror how `evidenceQuote` and `evidencePublisher` were added: a nullable field on the shared record, then through `ExaResult`, `CompanyRow` and `CompanyMatch`. Required in the request schema only when `plan.recency` is set. The kinds are company announcement, person announcement, news article, regulatory filing, vendor case study, job posting, status page, other.
2. **`judgePrompt` builds each row with `JSON.stringify(row)` over the whole `CompanyRow`, so a new field reaches the judge automatically.** Destructure it out before serialising: `const { evidenceKind, ...judged } = row`. Without this step KTD3 is violated by doing nothing.
3. Put the eight-kind enum in the request schema in `agent-search.ts`, not in `agent.ts` — see Risks on file size.

**Test scenarios**
- The request schema requires `evidenceKind` when the profile asks for something recent, and omits it when it does not.
- The kind reaches the row and the stored capture.
- The judge prompt contains the row's other fields and does not contain `evidenceKind`.

**Verification** `bun run gate`.

### U4. `buildIcp` — a domain becomes a description

**Goal** One plain function does the whole job.

**Requirements** R5

**Dependencies** U1

**Files**
- `src/core/onboard.ts` (new)
- `src/core/providers/exa/search.ts` — widen `contents` for the live crawl
- `test/onboard.spec.ts` (new)

**Approach**
1. **The request shape does not fit the current schema.** `ExaSearchRequestSchema` types `contents.text` as a boolean and has no `maxAgeHours` or `livecrawlTimeout`, so the measured request throws at parse and the live-crawl fields are silently stripped. Widen `contents.text` to accept `{ maxCharacters }` and add both fields first.
2. A plain async function taking `env`, a domain and an optional note, returning the description, the seller block and a cost ledger. No HTTP, no Workflows, no env globals — the `src/core/` rule.
3. One `search` call: `type: "deep"`, `includeDomains: [domain]`, ten `additionalQueries`, `contents` with text and a live crawl. The exact ten queries are in `.claude/skills/icp-profile/scripts/read-seller.mjs`; read it.
4. One `generateStructured` call on `reasoningModel` returning a Zod-typed object: the description plus the seller block for KTD1. **The note is untrusted caller input**: cap it in the request schema and place it in a clearly delimited data section of the prompt, never inside the model instructions.
5. Fallbacks: no pages but a note present, return a description built from the note; the model returning nothing twice with pages present, the same; neither pages nor note, throw `NonRetryableError`.

The four blocks the description must contain are in
`.claude/skills/icp-profile/references/structure.md`; read it and put those rules in
the model instructions.

**Patterns to follow** `src/core/synthesize.ts` — schema, instructions,
`generateStructured`, a ledger, a fallback when the model returns nothing twice.

**Test scenarios**
- The request sends `type: "deep"`, the domain in `includeDomains`, ten `additionalQueries`, and the live-crawl fields survive schema validation.
- A search returning pages and a model returning a profile yields the description and the seller block.
- The note reaches the prompt inside its delimited section, and a note past the cap is rejected.
- No pages with a note present still returns a description.
- The model returning nothing twice with pages present still returns a description.
- Neither pages nor note throws `NonRetryableError`.

**Verification** `bun run gate`.

### U5. The onboarding Workflow and its endpoint

**Goal** Onboarding runs off the request path, is startable by an API call, and
its spend is counted.

**Requirements** R6, R7

**Dependencies** U4

**Files**
- `src/workflows/onboard-icp.ts` (new)
- `src/core/db/queries.ts` — `createIcp` writes the whole document, not only the description
- `wrangler.jsonc` — the `ONBOARD_ICP` binding
- `src/index.ts` — export the entrypoint
- `worker-configuration.d.ts` — regenerated after the export lands
- `src/routes.ts`, `src/http/jobs.ts` — `POST /icp/onboard`, and `CAPABILITIES` gains `onboarding`
- `src/http/runs.ts` — `workflowForCapability` learns the new capability
- `src/http/schemas.ts` — the request body
- `src/http/openapi.ts` — declare the route
- `test/onboard-workflow.spec.ts` (new), `test/db.spec.ts`

**Approach**
1. **`createIcp` hardcodes `doc: { description: input.description }`**, so a seller block passed beside it is dropped. Extend `NewIcpInput` and have it write the whole `IcpDocSchema` document.
2. A `WorkflowEntrypoint` whose payload is parsed by a Zod schema — the `FindCompaniesPayloadSchema.parse(event.payload)` pattern — running `normalizeDomain` on the domain and failing as `NonRetryableError` on anything that is not a public hostname. Both entry paths cross this parse, so it is the one place validation belongs.
3. Three `step.do` calls, in this order. A database step that refuses with `NonRetryableError` when `organizationSpendToday` has reached `config.spend.perAccountDailyDollars`. A paid step running `buildIcp`. A database step that calls `createIcp`, then `openRun` with the returned icp id and `closeRun` carrying the ledger's cost. The run opens last because `run.icpId` is `notNull` and references `icp.id` — KTD6.
4. `POST /icp/onboard` takes `{ domain, note? }`, resolves the caller's organization from the API key exactly as the other routes do, and returns `{ runId, status }`. The run id is derived per organization, per domain, per day through `domainsScopeId([domain], organizationId)`, so a repeat start on the same day returns the existing run.
5. Register the binding in `wrangler.jsonc`, export the class from `src/index.ts`, then run `bun run cf-typegen` and commit the regenerated `worker-configuration.d.ts`. The generated `Env` entry resolves the payload type through `src/index.ts`, so the regen must run last or the types step fails with no obvious cause.
6. Declare the route in `src/http/openapi.ts` — the repo hand-maintains one `createRoute` per mounted route, and nothing in the gate catches an undeclared one. `enrichRoute` is the closest shape.

**Patterns to follow** `src/workflows/find-companies.ts` for the entrypoint,
payload parse and `step.do` budgets; `src/http/jobs.ts` for organization resolution
and `domainsScopeId`; `src/http/openapi.ts` `enrichRoute` for the route.

**Test scenarios**
- The endpoint rejects a body with no domain, and one whose domain is not a public hostname.
- The endpoint returns a run id and does not wait for the profile.
- The workflow writes one ICP row carrying the description and the seller block.
- The workflow writes a run row whose cost is the ledger's total, and `GET /runs/:runId` resolves it.
- A second start for the same organization and domain on the same day does not write a second row.
- An account at its daily ceiling gets no paid call.

**Verification** `bun run gate`, then `bunx wrangler dev` and one live call.

### U6. Start it when an organization is created

**Goal** Signing up with a domain begins onboarding, without delaying the user.

**Requirements** R6

**Dependencies** U5

**Files**
- `src/auth-options.ts` — export a function that builds the plugin list
- `src/auth.ts` — `createAuth` supplies `afterCreateOrganization`
- `test/auth-onboard.spec.ts` (new)

**Approach**
1. `auth-options.ts` exports `buildPlugins(afterCreateOrganization?)`. `authOptions` calls it with nothing, so the schema generator is unchanged.
2. `createAuth`'s parameter widens from `DbEnv` to `Env` so the hook can read the Workflow binding. Both existing callers and both existing tests already pass a full `Env`.
3. The hook reads the created organization through a Zod parse rather than a cast — the library types the additional field through an index signature, and CLAUDE.md bans type assertions. It starts `ONBOARD_ICP` when a domain is present and does nothing when it is not.
4. The hook only starts the Workflow. It never awaits the profile, so signup returns at its current speed.

**Execution note** The hook must not throw into the signup path. A failed
Workflow start is logged and swallowed, and the log line carries the organization
id only — never the note or the whole row, which are caller-supplied. An account
that exists without a profile is recoverable through the endpoint; an account that
fails to be created is not.

**Test scenarios**
- Creating an organization with a domain starts exactly one Workflow with that domain and organization id.
- Creating an organization with no domain, or with a domain that is not a hostname, starts none.
- A Workflow start that throws does not fail organization creation.

**Verification** `bun run gate`.

---

## Verification Contract

`bun run gate` — all eight checks: config, types, biome, comments, language,
steps, tests, bundle. No subset counts.

After U5, one live check through `bunx wrangler dev`: `POST /icp/onboard` with a
real domain, then `GET /runs/:runId` and the written `icp` row.

---

## Definition of Done

- `bun run gate` passes.
- An agent request built from a profile carrying a seller names that seller's
  domain, its customers, and the competitor test.
- The agent prompt admits a LinkedIn post and bars a `linkedin.com/in` profile.
- A plan whose model output omits `agentEffort` carries `medium`.
- A stored company row carries `evidenceKind`, and the judge prompt does not.
- `POST /icp/onboard` returns a run id that `GET /runs/:runId` resolves, and an
  `icp` row appears carrying the description and the seller block.
- The onboarding run's cost is recorded against the account's day.
- Creating an organization with a domain starts onboarding; creating one without a
  domain does not.

---

## Open Questions

- **What bounds signup-triggered onboarding?** Registration is open
  (`emailAndPassword: { enabled: true }`), API keys are exempt from the plugin's
  rate limit by design, and every new organization starts at zero recorded spend,
  so the daily ceiling cannot stop an account created for the purpose. The ceiling
  check in U5 bounds a single account, not account creation itself. Decide before
  this is reachable from a public signup: a verified email before the hook fires, a
  per-user organization cap, or an edge rate limit on the org-create endpoint.
- Should a repeat onboarding for a domain the organization already has replace the
  existing profile or add another? `icp` has no uniqueness constraint on
  `(organization_id, domain)`, so today it accumulates.

---

## Risks

- **`CompanyField` grows again in U3.** Every fixture building a `CompanyRow` needs
  the new key. This happened three times in one session; sweep the fixtures in one
  pass.
- **Two files U3 edits are near the 400-line ceiling.**
  `src/core/providers/exa/agent.ts` sits at 391 non-blank lines and
  `src/core/companies/candidates.ts` at 387. Put the eight-kind enum in
  `agent-search.ts`. If either crosses, the answer is a split, not a raised limit.
- **A new Workflow needs four artifacts, not two.** The binding, the export, the
  route declaration, and a regenerated `worker-configuration.d.ts`. Missing the
  regen fails the types check with no obvious cause.
- **The signup hook sits on the account-creation path.** Swallow its failures or a
  vendor outage stops signups.

---

## Sources

- Session measurements of 2026-08-30, carried in the Key Technical Decisions with
  the numbers that produced each choice.
- `.claude/skills/icp-profile/references/structure.md` — the four blocks.
- `.claude/skills/icp-profile/scripts/read-seller.mjs` — the measured search shape.
- Better Auth: `organizationHooks.afterCreateOrganization` receives
  `{ organization, member, user }`, verified in
  `node_modules/better-auth/dist/plugins/organization/types.d.mts`.
