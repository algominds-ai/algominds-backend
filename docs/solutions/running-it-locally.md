# What a fresh deploy needs

Every unit is tested and the vendors are verified live. A fresh deploy needs
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

## Database

Run `bun run db:migrate` against the production `DATABASE_URL` once. That
applies `drizzle/0000_baseline.sql`, which creates every table this Worker
and its auth layer need. `wrangler dev` needs no separate step: it reads the
local Postgres at `localhost:5432/algo` through the `localConnectionString`
already set on both Hyperdrive bindings in `wrangler.jsonc`.

## What is proven without a deploy

- Every vendor call, against live APIs. See `vendor-probe-findings.md`.
- The full chain end to end, calling vendors directly: an ICP search returned
  real seed fintech companies, a people search returned real decision makers with
  current employment, and a LinkedIn URL resolved to a deliverable address, for
  about $0.019 and one Findymail credit.
- Every capability function, against injected fakes, across the test suite.
- The full local stack, including real bindings and a real database: `wrangler
  dev` against the local Postgres above, migrated with `bun run db:migrate`.

## What only a deploy proves

Real Hyperdrive resolving against the production database, and Workflow steps
persisting across Cloudflare's own engine rather than the local one `wrangler
dev` runs. That gap closes on the first deploy, not before.
