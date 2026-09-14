# What a fresh deploy needs

A fresh deploy needs
three things: the two Hyperdrive configurations, the four secrets-store
secrets, and one migration run against the production database.

## Hyperdrive

`wrangler.jsonc` declares two Hyperdrive bindings against the same database,
`HYPERDRIVE_CACHED` and `HYPERDRIVE_DIRECT` (caching disabled, used for
dedupe reads). Both still carry the placeholder ids `<algo-cached-id>` and
`<algo-direct-id>`. Create each with `wrangler hyperdrive create`, the exact
commands are the comment above the `"hyperdrive"` block, and put the real ids
in their place.

## Secrets — four, in `default_secrets_store` (`5ad6bd7de0494762a21914ec40d3e4da`)

`exa-api-key`, `findymail-api-key`, `cf-aig-token`, `clay-api-key`. Create each
with the `wrangler secrets-store secret create` command in `wrangler.jsonc`.

**The Vitest pool cannot see them.** Its Miniflare instance persists to a
different directory than the Wrangler CLI, and `secretsStoreSecrets` only
accepts `{store_id, secret_name}` — it points at a store, it cannot inject
values. So a test that calls a real binding fails with `Secret "cf-aig-token"
not found` even though the secret exists. This does not affect the test
suite: every unit test injects a fake binding (`{ get: async () => "test-key"
}`), which is the correct thing for a test to do. It only blocks a live run
from inside Vitest.

## Local development secrets

Local development reads every secret and variable from `.env`; do not create a `.dev.vars`
file. When `.dev.vars` exists, Wrangler stops reading `.env`, loads only `.dev.vars` as
secrets, and the empty `vars` in `wrangler.jsonc` (`AI_GATEWAY_BASE_URL`, `MODEL_ROUTE_REASONING`,
`MODEL_ROUTE_WORKER`, `CF_GATEWAY_ID`) win instead, so every model call fails with
`TypeError: Invalid URL string.` in the synthesizer step. The server's first log line shows
which file it loaded (`Using secrets defined in .env`).

## Database

Run `bun run db:migrate` against the production `DATABASE_URL` once. That
applies `drizzle/0000_baseline.sql`, which creates every table this Worker
and its auth layer need. `wrangler dev` needs no separate step: it reads the
local Postgres at `localhost:5432/algo` through the `localConnectionString`
already set on both Hyperdrive bindings in `wrangler.jsonc`.

## Local verification

Run `bun run gate` for the repository checks and Workers tests. Use the
independent [engine evals](eval.md) for live provider and engine measurements.
Passing tests does not establish current provider behavior or discovery quality.

## What only a deploy proves

Real Hyperdrive resolving against the production database, and Workflow steps
persisting across Cloudflare's own engine rather than the local one `wrangler
dev` runs. That gap closes on the first deploy, not before.
