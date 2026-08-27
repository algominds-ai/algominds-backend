# Why `test/waterfall.spec.ts` runs a fake MCP server instead of mocking

`lint/anti-slop/no-module-mocking.grit` bans `vi.mock`, `mock.module`, and `jest.mock` in every
file, tests included. Proving `mcpProvider` resolves headers per call and closes its client in
a `finally` needs a real request/response boundary, not a mocked import.

## The fake server

`test/waterfall.spec.ts` overrides `globalThis.fetch` for the duration of the `mcpProvider`
tests and restores it in `afterEach`. The override answers the actual MCP-over-HTTP JSON-RPC
protocol `@ai-sdk/mcp`'s client sends, closely enough to complete a real handshake.

## Why protocol discovery is made to fail on purpose

`createMCPClient` tries a `server/discover` probe before falling back to the legacy
`initialize` handshake. The modern-protocol path wraps every result in a `resultType` field and
nests request params inside `_meta`; the legacy path does neither. The fake server answers
`server/discover` with an unrecognised JSON-RPC error code (not one of the client's
"modern protocol" codes), so the client always falls back to the simpler legacy handshake.

## Why the fake sets an `mcp-session-id` header

Without a session id, `client.close()` never issues an HTTP request — it just aborts locally,
leaving nothing to observe. Every response carries `mcp-session-id`, so `close()` sends a real
`DELETE`, which the fake server counts. That count is the proof that `run` closed the client
even on the branch where the tool call fails.
