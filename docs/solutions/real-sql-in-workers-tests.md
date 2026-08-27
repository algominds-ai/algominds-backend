# Real SQL from the Workers test runtime

Tests under `@cloudflare/vitest-plugin` can query the real local Postgres
today. No extra infrastructure, no second Vitest project, no Node-runtime
escape hatch.

## Why it already works

`vitest.config.ts` hands the plugin the same config the dev server uses:

```
cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })
```

`wrangler.jsonc` gives each Hyperdrive binding a `localConnectionString`
pointing at `postgresql://postgres:postgres@localhost:5432/algo`. The binding
resolves to that string inside the test isolate, so `db(env, "cached")` opens a
real connection and `postgres-js` runs real statements.

## The measured probe

One throwaway spec imported `db` from `@/core/db/client` and selected three
rows from `icp`. It passed in 2.15 seconds against the live local database.

## What this means for tests

- An integration test may exercise real SQL, real indexes, and the real
  schema. A query plan or a missing index is provable, not assumed.
- The `DbFactory` seam stays useful for unit tests that must not touch a
  database. It is a choice now, not the only option.
- Both Hyperdrive bindings resolve, so a test can prove that the dedupe read
  goes through the cache-disabled one.

## What to watch

- Tests share one database. `fileParallelism` is already `false`, which keeps
  files from racing each other. A test that writes must still clean up after
  itself, or scope its rows to an id no other test uses.
- The local database holds real rows from earlier runs. A test that counts
  rows without a filter reads other people's data and fails later for no
  reason.
- This depends on `localConnectionString`. Remove it and every such test
  fails at connect time.
