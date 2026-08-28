# algo-backend

Algominds GTM engine. Three capabilities that turn an ICP document into verified, enriched
decision makers: **find companies**, **find people**, **enrich people**.

Cloudflare Workers + Workflows · Hono · Zod · Drizzle · Postgres (PlanetScale via Hyperdrive)
· `ai@7` through Cloudflare AI Gateway.

**The spec is `docs/plans/2026-08-27-001-feature-gtm-engine-core-apis-plan.md`.** Requirements,
vendor contracts, and decisions live there, not here. Read it before changing behaviour. Do not
copy its content into this file.

## Commands

**`bun run gate` is the gate.** It runs every check and prints a pass/fail line per check.
No subset of it counts as passing — `biome check` alone is one of them, not the linter.

```bash
bun run gate                      # THE gate: config, types, biome, comments, language, steps, tests, bundle

bun install --frozen-lockfile
bunx tsc --noEmit
bun run lint                      # biome + comments + language
bun run test                      # vitest on the real Workers runtime
bunx wrangler deploy --dry-run    # bundle check — must stay clean
bunx wrangler dev
bunx drizzle-kit push
```

## Layout

```
src/core/        plain async functions. no HTTP. no Workflows. no env globals.
src/core/providers/   one file per provider + the waterfall + the MCP adapter
src/workflows/   one WorkflowEntrypoint per capability. calls src/core/.
src/routes.ts    Hono. a route only starts a Workflow and returns a run id.
```

`src/core/` never imports from `src/routes.ts` or `src/workflows/`. The arrow points one way.

## Coding standards

- **Laziest thing that works.** Stdlib before a helper, a platform feature before a dependency,
  one line before fifty. No abstraction with one implementation.
- **Plain functions and plain objects.** No registry classes, no base classes, no dependency
  injection container. A provider is an object literal; a channel is an array.
- **Take collaborators as arguments.** No module-level singletons, no module-level secrets.
  Anything needing a binding takes `env` as a parameter.
- **Exact version pins.** No carets. Commit `bun.lock`. A new dependency needs a reason a few
  lines of code could not cover.
- **Zod schema is the type.** Infer types from it. Never hand-write a matching interface.
- **Tests run on the Workers runtime** under `@cloudflare/vitest-pool-workers`. Node-runtime
  tests do not count — runtime compatibility is the main risk here.
- **Non-trivial logic leaves one runnable check behind.** A branch, a loop, a parser, or a
  money path gets a test. Trivial one-liners do not.
- **No relative imports.** Biome bans `./*` and `../*` outside `test/`. Use `@/*`.
- **Repo-relative paths everywhere.** Never absolute.
- **No comments. None.** Rename until the code says it. If something genuinely needs
  explaining, write `docs/solutions/<topic>.md`. Only `/** */` docstrings are allowed, and only
  where a signature is genuinely non-obvious. Enforced by `scripts/check-comments.mjs`.
- **A docstring says what the thing does and what it returns.** One or two sentences. Not an
  essay, not rationale, not history. If it needs a paragraph, it belongs in `docs/solutions/`.
- **No planning vocabulary in code — ever.** No requirement, decision, acceptance-example or
  unit ids (`R42`, `KTD3`, `AE7`, `U12`), no "milestone", "phase", "sub-phase", "the plan says".
  A test is named for the behaviour it proves, never the plan entry it traces to. Enforced by
  `scripts/check-language.mjs`.
- **No type assertions, anywhere.** `as X` is banned in src and test alike (`as const` is
  fine). Declare the real type, annotate the variable, or parse at the boundary with Zod. Every
  cast so far had a cleaner alternative: the real `env` from `cloudflare:workers`, `new
  Headers()`, or a plain type annotation.
- **No untyped bags.** `Record<string, unknown>`, `Record<string, any>`, `object`, and
  `Function` are banned. Declare the shape.
- **Size limits, enforced:** 80 lines per function, 400 per file, cognitive complexity 10,
  4 parameters. Hitting one is a signal to split, not to raise the limit.

## Invariants that are not style

Break these and the product is wrong, not just untidy.

- A provider that misses returns `null`. The waterfall moves on. Only a retryable error throws.
- **Waterfall providers and direct dependencies fail differently, on purpose.** A waterfall
  provider (Apollo, Findymail) returns `null` on a miss so the next one runs. A direct
  dependency (Exa) has no next, so it throws: `RetryableProviderError` for 429 and 5xx,
  Cloudflare's `NonRetryableError` from `cloudflare:workflows` for a bad request or a
  response that does not match the expected shape.
- Nothing holds an HTTP connection open waiting for a vendor.
- `evidence` is append-only. Never delete a value; lower its confidence.
- The dedupe read uses the cache-disabled Hyperdrive binding.
- The synthesizer must send `cf-aig-skip-cache`. A cache hit there silently repeats yesterday's
  companies.
- `undici` and `cross-spawn` are aliased to throwing stubs in `build/`. They arrive
  transitively and cannot run on Workers. Do not remove them.

## Git

Sole author is Lahfir. No co-author trailers, no AI attribution anywhere.
