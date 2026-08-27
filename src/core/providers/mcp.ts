import type { CallToolResult } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";
import type { Channel, Provider } from "@/core/providers/types";

export type MCPProviderConfig<O> = {
	id: string;
	url: string;
	tool: string;
	channels: Channel[];
	cost: number;
	/**
	 * Resolved from `env` on every call. See `docs/solutions/mcp-provider-adapter.md`
	 * for why this cannot be a plain value.
	 */
	headers?: (env: Env) => Record<string, string>;
	parse: (raw: unknown) => O | null;
};

function isAsyncIterableResult(
	value: CallToolResult | AsyncIterable<CallToolResult>,
): value is AsyncIterable<CallToolResult> {
	return (
		typeof value === "object" && value !== null && Symbol.asyncIterator in value
	);
}

async function drainToLastResult(
	stream: AsyncIterable<CallToolResult>,
): Promise<CallToolResult | null> {
	let last: CallToolResult | null = null;
	for await (const chunk of stream) last = chunk;
	return last;
}

export function mcpProvider<I = unknown, O = unknown>(
	cfg: MCPProviderConfig<O>,
): Provider<I, O> {
	return {
		id: cfg.id,
		channels: cfg.channels,
		cost: cfg.cost,
		async run(input, env) {
			const headers = cfg.headers?.(env);
			const client = await createMCPClient({
				transport: {
					type: "http",
					url: cfg.url,
					...(headers ? { headers } : {}),
				},
				maxRetries: 0,
			});
			try {
				const tools = await client.tools();
				const tool = tools[cfg.tool];
				if (!tool) return null;
				const outcome = await tool.execute(input, {
					toolCallId: cfg.id,
					messages: [],
					context: undefined,
				});
				const result = isAsyncIterableResult(outcome)
					? await drainToLastResult(outcome)
					: outcome;
				return result === null ? null : cfg.parse(result);
			} finally {
				await client.close();
			}
		},
	};
}
