# Why `recentDomains` never reads through the cached Hyperdrive binding

`wrangler.jsonc` declares two Hyperdrive configurations against the same Postgres database:
`HYPERDRIVE_CACHED` and `HYPERDRIVE_DIRECT` (caching disabled). `src/core/db/queries.ts`'s
`recentDomains` hardcodes the direct binding and gives callers no way to override it.

## The problem

Hyperdrive caches read results for a default `max_age` of 60 seconds, with a 15-second
stale-while-revalidate window on top. A workflow that writes a batch of companies and, moments
later, reads back "which domains have we already stored" to exclude them from the next round
can hit a cache entry that predates the write. The read returns fewer domains than were just
written, and the next round re-fetches companies already on file.

## Why this is a binding choice, not a query option

Cloudflare's own guidance for this exact situation is a second Hyperdrive configuration created
with `--caching-disabled`, used only for reads that must see the latest write. A per-call cache
bypass at the query level does not exist for Hyperdrive; the cache is a property of the
connection string it's configured against.

Because of that, `recentDomains` builds its connection with `db(env, "direct")` unconditionally,
rather than accepting a `mode` argument. A caller cannot accidentally read this list through the
cache.

## Why `db()` builds a client per call instead of caching one at module scope

Workers bindings (`env.HYPERDRIVE_DIRECT`, `env.HYPERDRIVE_CACHED`) only exist once a request is
in flight. A client built at module load time would either fail immediately or capture bindings
from whichever request happened to trigger the module's first evaluation. `db(env, mode)` is
called fresh inside every query function instead.

## Verification

`test/db.spec.ts` proves the binding split two ways: a `db()`-level test builds two clients from
distinguishable connection strings and inspects `$client.options` to confirm they differ, and a
`recentDomains`-level test injects a connection factory and asserts the mode argument it receives
is always `"direct"`.
