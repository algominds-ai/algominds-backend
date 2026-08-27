# algo-backend

Algominds GTM engine. Three capabilities that turn an ICP document into verified, enriched
decision makers: **find companies**, **find people**, **enrich people**.

Full spec: `docs/plans/2026-08-27-001-feature-gtm-engine-core-apis-plan.md`. That plan is the
source of truth. Read it before changing behaviour.

## The governing rule

> Code decides **whether** a fact is acceptable.
> A model decides only **what to ask for next**.
> A tool loop appears only where the answer needs a live lookup.

Every architectural choice follows from this. If a change breaks it, the change is wrong.

## Stack

Cloudflare Workers + Workflows · Hono · Zod · Drizzle · Postgres on PlanetScale through
Hyperdrive · `ai@7` through Cloudflare AI Gateway (dynamic route, OpenRouter behind it).

Package manager is `bun`. Versions are exact-pinned and `bun.lock` is committed.

## Commands

```bash
bun install --frozen-lockfile
bunx tsc --noEmit
bun run test              # vitest under @cloudflare/vitest-pool-workers
bunx wrangler deploy --dry-run   # bundle check — must stay clean
bunx wrangler dev
bunx drizzle-kit push
```

Tests run on the **real Workers runtime**. Do not add Node-runtime tests; runtime
compatibility is the main risk this project carries.

## Layout

```
src/core/        plain async functions. No HTTP. No Workflows. No env globals.
src/core/providers/   one file per provider + the waterfall + the MCP adapter
src/workflows/   one WorkflowEntrypoint per capability. Calls src/core/.
src/routes.ts    Hono. A route only starts a Workflow and returns a run id.
```

`src/core/` never imports from `src/routes.ts` or `src/workflows/`. The dependency arrow
points one way. That is what makes the functions callable from a future end-to-end workflow.

## Adding a provider

One file, one array entry:

```ts
// src/core/providers/hunter.ts
export const hunterEmail: Provider<In, Out> = {
  id: 'hunter', channels: ['email'], cost: 2,
  async run(input, env) { /* return null on a miss */ },
}
```

```ts
// src/core/providers/index.ts
export const EMAIL = [apolloEmail, hunterEmail, clayEmail]
```

An MCP provider needs no file at all — one `mcpProvider({...})` entry in the array.
Do not add a registry, a plugin loader, or a base class.

## Hard rules

- A provider that throws is a **miss**. The waterfall continues. Never fail a run on one provider.
- Never hold an HTTP connection open waiting for a vendor. `POST` returns a run id.
- There is no `runs` table. `instance.status()` returns `{ status, output }`.
- The dedupe read uses `HYPERDRIVE_DIRECT` (caching off). Hyperdrive does not invalidate on
  PlanetScale writes, so a cached read after a write re-delivers companies.
- `evidence` is append-only. Never delete a value; lower its confidence.
- An email with status `unknown` is never sendable. Only Apollo `email_status: "verified"`
  yields `verified`.
- Every Exa field that carries evidence is **optional** in `outputSchema`. A required field
  forces the agent to invent a value.

## Gotchas that will cost you a day

- `undici` and `cross-spawn` arrive transitively (`@ai-sdk/provider-utils`, `@ai-sdk/mcp`) and
  cannot run on Workers. Both are aliased to throwing stubs in `build/`. Do not remove them.
- `generateObject` is deprecated in `ai@7`. Use `generateText` + `Output.object()`.
- `generateText` defaults `stopWhen` to `isStepCount(1)`. `ToolLoopAgent` defaults to 20.
  Add a tool to a `generateText` call without setting `stopWhen` and it stops after one step.
- `system` is now `instructions`. `onFinish` is now `onEnd`.
- The Workers subrequest budget is **per Workflow instance**, not per step. Set
  `limits.subrequests` explicitly.
- Exa `stopReason: "schema_satisfied"` means the *shape* matched with nulls allowed. It is not
  proof the row count was met. Count rows yourself.
- Exa sends no `Retry-After` and has no idempotency header. The `step.do` retry config is the
  only backoff; the Workflow instance id is the only dedupe.
- Exa `dataSources` items are objects `{provider: "fiber"}`, not strings. Max 5. Crunchbase is
  not in the enum.
- Exa `/stop` works only on `max` effort. Use `/cancel`.
- Apollo People **Search** is free and returns no email or phone. `bulk_match` costs credits and
  takes 10 people per call. Never set a reveal flag from `findPeople`.
- Clay is not free. ~$0.05 per Data Credit, 6-20 per person. It is last in every waterfall and
  never used for discovery.

## Not in this project

Websets. The Exa MCP server. Redis or BullMQ. A queue product. Service bindings or RPC. A
plugin framework. A `runs` table. `budget.maxCostDollars`. `auto`/`max` effort.
`previousRunId`. Apollo company search. BrightData discovery mode. A separate email-verification
vendor. `WorkflowAgent` from `@ai-sdk/workflow`.

The daily end-to-end workflow and the campaign push are separate plans, not this one.
