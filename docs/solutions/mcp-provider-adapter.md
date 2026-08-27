# Why `mcpProvider` shapes its config and output the way it does

`src/core/providers/mcp.ts` makes three choices that are not obvious from the code alone.

## `headers` is a function of `env`, not a value

Workers bindings and secrets do not exist at module scope — they only exist inside a request
or Workflow step, as the `env` parameter. `EMAIL`, `LINKEDIN`, and the other channel arrays in
`src/core/providers/index.ts` are built at module scope, so a header value baked in there could
never hold a real key. `mcpProvider` resolves `cfg.headers(env)` inside `run`, once per call,
so the key always comes from the `env` the caller actually has.

## `maxRetries: 0` is passed explicitly

The `@ai-sdk/mcp` client already defaults `maxRetries` to `0`. Passing it explicitly costs one
line and stops a future library upgrade that changes that default from silently changing our
retry behaviour underneath the waterfall's own retry semantics.

## The output type is `CallToolResult`, not a caller-chosen generic

An earlier draft let the caller pick an arbitrary output type and cast the MCP response into
it. That cast had no runtime backing — the tool call genuinely returns a `CallToolResult`, so
asserting it into an unrelated shape would have been a lie the type checker couldn't catch.
`mcpProvider<I>` fixes the output type to `CallToolResult`, the type `@ai-sdk/mcp` actually
returns. A future provider that needs a narrower domain type parses `content` or
`structuredContent` itself, with a Zod schema, at its own call site.

`Tool.execute` is typed to allow a streaming result (`AsyncIterable<CallToolResult>`) because
the `Tool` interface supports tools in general, even though the tools `@ai-sdk/mcp` builds
under `client.tools()` never actually stream. `isAsyncIterableResult` narrows that union at
runtime instead of asserting past it, and `drainToLastResult` takes the last chunk if a future
version of the client ever does stream.

## Verification

`test/waterfall.spec.ts` proves the header is resolved per call (two calls with different `env`
values produce different outgoing headers) and that the client is closed in a `finally` even
when the tool call fails.
