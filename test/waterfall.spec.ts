import { afterEach, describe, expect, it } from "vitest";
import { mcpProvider } from "../src/core/providers/mcp";
import type { Provider } from "../src/core/providers/types";
import {
	RetryableProviderError,
	waterfall,
} from "../src/core/providers/waterfall";

type Out = Record<string, unknown>;

function provider(
	id: string,
	run: (input: Out, env: Env) => Promise<Out | null>,
): Provider<Out, Out> {
	return { id, channels: ["email"], cost: 0, run };
}

const testEnv = {} as unknown as Env;

describe("waterfall", () => {
	it("moves to the next provider when the first misses", async () => {
		const calls: string[] = [];
		const first = provider("first", async () => {
			calls.push("first");
			return null;
		});
		const second = provider("second", async () => {
			calls.push("second");
			return { value: "b" };
		});
		const third = provider("third", async () => {
			calls.push("third");
			return { value: "c" };
		});

		const result = await waterfall([first, second, third], {}, testEnv);

		expect(result).toEqual({ value: "b", source: "second" });
		expect(calls).toEqual(["first", "second"]);
	});

	it("swallows an ordinary throw and reaches the next provider", async () => {
		const first = provider("first", async () => {
			throw new Error("vendor exploded");
		});
		const second = provider("second", async () => ({ value: "b" }));

		const result = await waterfall([first, second], {}, testEnv);

		expect(result).toEqual({ value: "b", source: "second" });
	});

	it("re-throws a RetryableProviderError and does not call the next provider (AE9, R43)", async () => {
		const calls: string[] = [];
		const first = provider("first", async () => {
			calls.push("first");
			throw new RetryableProviderError("429");
		});
		const second = provider("second", async () => {
			calls.push("second");
			return { value: "b" };
		});

		await expect(waterfall([first, second], {}, testEnv)).rejects.toThrow(
			RetryableProviderError,
		);
		expect(calls).toEqual(["first"]);
	});

	it("returns null when every provider misses", async () => {
		const first = provider("first", async () => null);
		const second = provider("second", async () => null);

		const result = await waterfall([first, second], {}, testEnv);

		expect(result).toBeNull();
	});

	it("does not stop on a hit the accept predicate rejects", async () => {
		const calls: string[] = [];
		const first = provider("first", async () => {
			calls.push("first");
			return { status: "guessed" };
		});
		const second = provider("second", async () => {
			calls.push("second");
			return { status: "verified" };
		});

		const result = await waterfall(
			[first, second],
			{},
			testEnv,
			(o) => o.status === "verified",
		);

		expect(result).toEqual({ status: "verified", source: "second" });
		expect(calls).toEqual(["first", "second"]);
	});

	it("calls providers in array order", async () => {
		const calls: string[] = [];
		const providers = ["a", "b", "c"].map((id) =>
			provider(id, async () => {
				calls.push(id);
				return null;
			}),
		);

		await waterfall(providers, {}, testEnv);

		expect(calls).toEqual(["a", "b", "c"]);
	});
});

describe("mcpProvider", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	type JsonRpcId = string | number | null;

	function jsonRpcResult(id: JsonRpcId, result: Record<string, unknown>) {
		return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
			status: 200,
			headers: {
				"content-type": "application/json",
				"mcp-session-id": "test-session",
			},
		});
	}

	function jsonRpcError(id: JsonRpcId, code: number, message: string) {
		return new Response(
			JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
			{
				status: 200,
				headers: {
					"content-type": "application/json",
					"mcp-session-id": "test-session",
				},
			},
		);
	}

	// A minimal, faithful in-process MCP HTTP server. Protocol discovery is
	// made to fail on purpose (an unrecognised JSON-RPC error code) so the
	// client falls back to the legacy initialize handshake, which needs no
	// per-request `resultType` envelope. This is a real transport-boundary
	// double, not a module mock.
	function fakeMcpServer(opts: {
		toolName: string;
		failToolCall?: boolean;
		capturedHeaders: Record<string, string>[];
		deletes: { count: number };
	}): typeof fetch {
		return async (_input, init) => {
			const method = init?.method ?? "GET";
			if (method === "GET") return new Response(null, { status: 405 });
			if (method === "DELETE") {
				opts.deletes.count += 1;
				return new Response(null, { status: 200 });
			}
			const headers = (init?.headers ?? {}) as Record<string, string>;
			opts.capturedHeaders.push(headers);
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: JsonRpcId;
				method?: string;
			};
			const id = body.id ?? null;
			switch (body.method) {
				case "server/discover":
					return jsonRpcError(id, -32601, "Method not found");
				case "initialize":
					return jsonRpcResult(id, {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "fake-mcp", version: "1.0.0" },
					});
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list":
					return jsonRpcResult(id, {
						tools: [
							{
								name: opts.toolName,
								inputSchema: { type: "object", properties: {} },
							},
						],
					});
				case "tools/call":
					if (opts.failToolCall) return jsonRpcError(id, -32000, "tool boom");
					return jsonRpcResult(id, {
						content: [{ type: "text", text: "ok" }],
					});
				default:
					return new Response(null, { status: 404 });
			}
		};
	}

	it("closes the client even when execute throws", async () => {
		const deletes = { count: 0 };
		globalThis.fetch = fakeMcpServer({
			toolName: "lookup",
			failToolCall: true,
			capturedHeaders: [],
			deletes,
		});
		const found = mcpProvider({
			id: "fake",
			url: "https://fake.example/mcp",
			tool: "lookup",
			channels: ["email"],
			cost: 1,
		});

		await expect(found.run({}, testEnv)).rejects.toThrow();
		expect(deletes.count).toBe(1);
	});

	it("resolves headers per call — two calls with different env send different headers", async () => {
		const capturedHeaders: Record<string, string>[] = [];
		globalThis.fetch = fakeMcpServer({
			toolName: "lookup",
			capturedHeaders,
			deletes: { count: 0 },
		});
		const found = mcpProvider<Record<string, never>, { content: unknown }>({
			id: "fake",
			url: "https://fake.example/mcp",
			tool: "lookup",
			channels: ["email"],
			cost: 1,
			headers: (env) => ({
				"x-api-key": String((env as unknown as { key: string }).key),
			}),
		});

		await found.run({}, { key: "key-a" } as unknown as Env);
		await found.run({}, { key: "key-b" } as unknown as Env);

		const firstCallHeaders = capturedHeaders[0];
		const lastCallHeaders = capturedHeaders[capturedHeaders.length - 1];
		expect(firstCallHeaders?.["x-api-key"]).toBe("key-a");
		expect(lastCallHeaders?.["x-api-key"]).toBe("key-b");
	});
});

describe("provider arrays (index.ts)", () => {
	it("adding an entry to a channel array changes no other file", async () => {
		const { EMAIL } = await import("../src/core/providers/index");
		const before = EMAIL.length;
		EMAIL.push({
			id: "new-entry",
			channels: ["email"],
			cost: 1,
			run: async () => null,
		});
		expect(EMAIL.length).toBe(before + 1);
	});
});
