import { createMCPClient } from "@ai-sdk/mcp";
import type { Channel, Provider } from "@/core/providers/types";

export type MCPProviderConfig = {
	id: string;
	url: string;
	tool: string;
	channels: Channel[];
	cost: number;
	// Resolved per call, never baked in — Workers bindings do not exist at
	// module scope, so a header captured at array-build time could never
	// hold a real key (R27, R46).
	headers?: (env: Env) => Record<string, string>;
};

// Adapts an MCP tool into a `Provider`, not a second provider system.
export function mcpProvider<I = unknown, O = unknown>(
	cfg: MCPProviderConfig,
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
				// Explicit rather than relied-on: this is the documented default,
				// and spelling it out stops a silent library change from surprising us.
				maxRetries: 0,
			});
			try {
				const tools = await client.tools();
				const tool = tools[cfg.tool];
				if (!tool) return null;
				const result: unknown = await tool.execute(input, {
					toolCallId: cfg.id,
					messages: [],
					context: undefined,
				});
				return result as O;
			} finally {
				await client.close();
			}
		},
	};
}
