# What it takes to run this end to end

Every unit is tested and the vendors are verified live, but a full run through
the deployed path needs two things that are not provisioned yet.

## Secrets — done

`default_secrets_store` (`5ad6bd7de0494762a21914ec40d3e4da`) holds six:
`exa-api-key`, `apollo-api-key`, `findymail-api-key`, `cf-aig-token`,
`api-bearer-token`, `clay-api-key`. The first five exist both remotely and in
the local store; `clay-api-key` exists in the local store only until the first
deploy creates it remotely with the command in `wrangler.jsonc`.

**But the Vitest pool cannot see them.** Its Miniflare instance persists to a
different directory than the Wrangler CLI, and `secretsStoreSecrets` only accepts
`{store_id, secret_name}` — it points at a store, it cannot inject values. So a
test that calls a real binding fails with `Secret "cf-aig-token" not found` even
though the secret exists.

This does not affect the test suite: every unit test injects a fake binding
(`{ get: async () => "test-key" }`), which is the correct thing for a test to do.
It only blocks a live run from inside Vitest.

## Database — local

`wrangler dev` reads the local Postgres at `localhost:5432/algo` through the
`localConnectionString` on both Hyperdrive bindings in `wrangler.jsonc`, so a
full run works on the local stack with no remote database. Production still
needs the two Hyperdrive configurations named in `wrangler.jsonc` and their
ids in place of the placeholders.

## What is proven without either

- Every vendor call, against live APIs. See `vendor-probe-findings.md`.
- The full chain end to end, calling vendors directly: an ICP search returned
  real seed fintech companies, a people search returned real decision makers with
  current employment, and a LinkedIn URL resolved to a deliverable address, for
  about $0.019 and one Findymail credit.
- Every capability function, against injected fakes, across 202 tests.

## What is not

The glue at runtime: real bindings resolving, Workflow steps persisting across
a real engine, and Hyperdrive returning rows. That gap closes when the database
lands, not before, and it is the right next step.
