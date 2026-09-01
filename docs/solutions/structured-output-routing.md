# Structured output routing through the AI Gateway

## What went wrong

Every `generateStructured` call returned `null`, so `synthesize` fell back to
its template query and `judge` returned no verdicts. Nothing threw, so the
workflow reported `complete` with unfiltered rows: one company whose signal
echoed the query verbatim, and one with 186 employees against an
"under 20 people" profile.

## Two separate causes

1. **The schema never left the process.** `createOpenAICompatible` defaults
   `supportsStructuredOutputs` to `false`. With that default the SDK drops the
   JSON schema and sends `response_format: {"type": "json_object"}` only. The
   model returned free-form JSON, `Output.object` failed to validate it twice,
   and `generateStructured` returned `null` by design.

2. **The schema, once sent, hung the request.** A measured probe against
   `dynamic/brain-worker` with a strict `json_schema` body returned nothing
   after 117 seconds, and 524 on an earlier attempt. The same body with
   `"provider": {"require_parameters": true}` returned valid matching JSON in
   3.7 seconds. OpenRouter had been routing to a provider (Morph serving
   `deepseek/deepseek-v4-flash-0731`) that accepts the parameter and then
   stalls on it.

## The fix

`supportsStructuredOutputs: true` on the provider, and
`providerOptions.aigw.provider.require_parameters = true` on every structured
call. The `@ai-sdk/openai-compatible` chat model copies unknown
`providerOptions[<provider name>]` keys straight into the request body, so the
second flag reaches OpenRouter unchanged.

## How to re-check

Send one `chat/completions` request to the gateway with a strict `json_schema`
`response_format` and no `provider` field. If it hangs, the routing flag is
still doing real work.

## The same failure came back through `sort: "latency"`

Measured 2026-08-31 against `dynamic/brain-reasoning`, one strict `json_schema`
body sent nine times:

| routing sent | provider OpenRouter chose | replies that parsed as JSON |
|---|---|---|
| `require_parameters: true, sort: "latency"` | Azure | 0 of 3 |
| `require_parameters: true` | Claude Platform on AWS | 6 of 6 |

Azure accepts `response_format: json_schema` and then ignores it. It answered
in Markdown, starting `# Ondato — Company Profile`. `require_parameters` does
not exclude it, because the parameter is accepted. `sort: "latency"` is what
puts Azure first.

The cost is silent. `Output.object` refuses the reply, `generateStructured`
returns `null` after two paid attempts, and every caller falls back: onboarding
stores the caller's note as the profile, `synthesize` queries with the profile
text, and `judge` keeps every row. One onboarding run spent $0.127 this way and
reported `complete`.

`sort` is removed. Latency is not worth a reply the schema cannot read.
