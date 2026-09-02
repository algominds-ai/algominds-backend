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

## A `null` step mock does not suppress the step

`mockStepResult({ name: "open-run" }, null)` leaves the step running for real.
The value has to be defined; `{ id: "x" }` works where `null` does not.

The symptom is misleading. The step executes, fails against a database that
holds nothing it needs, and the instance reaches `errored` — so a test waiting
for `complete` waits until its own timeout and reports a hang rather than the
failure underneath. Two tests looked like a workflow deadlock for several runs
before the cause turned out to be the mock value.

Mock every step a workflow test does not intend to execute, and give each one a
defined value.

## The suite reads and writes `algo_test`, never `algo`

Every spec above still applies against a real database — only which one
changed. `bun run dev` and `wrangler dev` keep resolving both Hyperdrive
bindings to `localConnectionString` in `wrangler.jsonc`, `algo`. Vitest no
longer does: `vitest.config.ts` passes `cloudflareTest` a `miniflare.hyperdrives`
override,

```ts
miniflare: {
	hyperdrives: {
		HYPERDRIVE_CACHED: TEST_DATABASE_URL,
		HYPERDRIVE_DIRECT: TEST_DATABASE_URL,
	},
},
```

where `TEST_DATABASE_URL` is
`postgresql://postgres:postgres@localhost:5432/algo_test`. The plugin merges
this on top of the bindings it derives from `wrangler.jsonc` key by key
(`mergeWorkerOptions` in `miniflare`), so only the two Hyperdrive connection
strings change; every other binding still comes from the Wrangler config.
That merge is why the override belongs here and not behind an environment
variable — `wrangler dev` reads `wrangler.jsonc` directly and never sees it.

`algo_test` does not migrate itself. `test/global-setup.ts` runs once before
any spec, opens a plain `postgres` connection to it, and throws with `run
bun run db:test:reset` if that connection fails — a missing database now
fails once, with the fix, instead of every spec failing at its first
query. `bun run db:test:reset` recreates it from the single migration
baseline: `dropdb`/`createdb` against `algo_test` (with explicit
`-h -p -U postgres`, since the local role is `postgres`, not the OS user),
then `DATABASE_URL=…/algo_test drizzle-kit migrate`.
