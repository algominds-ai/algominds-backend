# One connection per database call, closed in finally

Fixed 2026-09-02. Every query function in `src/core/db/` now calls `withConnection`, which owns the connection lifetime.

## What broke

`db(env, mode)` built a fresh single-connection postgres client per call and never closed it, relying on a 20-second `idle_timeout` that fast test runs never let fire. `pg_stat_activity` hit the local `max_connections` limit of 100 within about a second. The symptoms were `sorry, too many clients already`, hung Workers requests, and intermittent failures in `test/routes.spec.ts` that cascaded when two vitest processes ran in parallel.

## The fix

`withConnection(env, mode, buildDb, run)` builds one connection, runs work against it, then ends the client in `finally`. Every query function in `src/core/db/*.ts` and the enrich path goes through it. The per-request auth check and `/api/auth/*` handler pass their connection through `createAuthWith(env, connection)` instead of building their own. The `idle_timeout` is 3 seconds as a backstop.

## Measured result

A 498-test run peaked at 5 concurrent connections. Three consecutive full runs and two concurrent route-suite runs all passed green.

## Dependency defect

Ending an idle connection under `postgres@3.4.9`'s Cloudflare Workers TCP polyfill always throws an unhandled `"Stream was cancelled."` rejection, whether application code or the library's own idle timer closes it. The application cannot catch or suppress it. `vitest.config.ts` filters exactly that message from exactly that file path in `onUnhandledError` and nothing else. Revisit when the dependency is bumped.

## The rule

Never open a connection outside `withConnection`. Never raise the server's `max_connections` as a fix. `test/routes.spec.ts` hardcoded four fixture icp ids and three run ids, so concurrent test runs raced to seed them under different organizations; they are now minted fresh per test run.
