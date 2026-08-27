# Why `build/stub-undici.ts` and `build/stub-cross-spawn.ts` exist

`wrangler.jsonc` aliases two packages to throwing stubs. Deleting either alias breaks the
build in a way that looks unrelated to the change.

## The problem

Both arrive transitively and neither can run on Workers:

- `@ai-sdk/provider-utils@5.0.32` depends on `undici@^7`. Undici is Node's HTTP client. Workers
  has a global `fetch`.
- `@ai-sdk/mcp@2.0.39` depends on `cross-spawn@^7`, used only by the MCP **stdio** transport,
  which spawns a child process. Workers cannot spawn a process. We use the `http` transport.

Neither is reachable at runtime, but both enter the bundle graph, so the bundle fails to
resolve without an alias.

## Why a throwing `Proxy` and not the documented options

Cloudflare documents three stub shapes: an alternative implementation, an empty no-op file, or
a file with a top-level `throw`.

- A **top-level throw** fires at import time. Both packages are imported at module scope, so
  the Worker would die at startup rather than on misuse.
- An **empty file** fails silently if the code is ever reached.

The `Proxy` imports cleanly and throws a named error only on real property access. Three lines,
and the failure names the package.

## Verification

`test/bundle.spec.ts` asserts each stub throws with its own package name in the message.
