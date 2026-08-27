import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { IcpDoc } from "../src/core/synthesize";
import { synthesize } from "../src/core/synthesize";

const env: Env = {
	...testEnv,
	AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
	CF_AIG_TOKEN: { get: async () => "test-aig-token" },
	MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
	MODEL_ROUTE_WORKER: "dynamic/brain-worker",
};

const icp: IcpDoc = {
	industry: "fintech",
	stage: "seed",
	geography: "United States",
};

type CapturedRequest = { url: string; headers: Headers; body: unknown };

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function userContent(request: CapturedRequest | undefined): string {
	if (!request) throw new Error("expected a captured request");
	const body = RequestBodySchema.parse(request.body);
	const message = body.messages.find((entry) => entry.role === "user");
	if (!message) throw new Error("expected a user message in the request body");
	return message.content;
}

function modelInBody(request: CapturedRequest | undefined): string {
	if (!request) throw new Error("expected a captured request");
	return RequestBodySchema.parse(request.body).model;
}

type ScriptedReply = {
	content: string;
	finishReason?: "stop" | "length";
	cost?: number;
	model?: string;
};

function chatCompletionResponse(reply: ScriptedReply): Response {
	const model = reply.model ?? "deepseek/deepseek-v4-flash-0731";
	const payload = {
		id: "chatcmpl-test",
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: reply.content },
				finish_reason: reply.finishReason ?? "stop",
			},
		],
		usage: {
			prompt_tokens: 20,
			completion_tokens: 8,
			cost: reply.cost ?? 0.000002,
		},
	};
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"cf-aig-model": model,
			"cf-aig-provider": "openrouter",
			"cf-aig-cache-status": "MISS",
		},
	});
}

function fakeGateway(responses: readonly Response[]): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
} {
	const calls: CapturedRequest[] = [];
	let index = 0;
	const handler: typeof fetch = async (input, init) => {
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body,
		});
		const response = responses[index];
		index += 1;
		if (!response)
			throw new Error(`fakeGateway: no scripted response for call ${index}`);
		return response;
	};
	return { fetch: handler, calls };
}

function objectReply(value: unknown, cost?: number): ScriptedReply {
	return cost === undefined
		? { content: JSON.stringify(value) }
		: { content: JSON.stringify(value), cost };
}

describe("synthesize: gateway wiring", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends cf-aig-authorization and targets a URL under /compat", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({ query: "q", systemPrompt: "s", dataSources: [] }),
			),
		]);
		globalThis.fetch = gateway.fetch;

		await synthesize(icp, [], env);

		const call = gateway.calls[0];
		expect(call?.headers.get("cf-aig-authorization")).toBe(
			"Bearer test-aig-token",
		);
		expect(new URL(String(call?.url)).pathname).toContain("/compat");
	});

	it("selects MODEL_ROUTE_WORKER in the request body", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({ query: "q", systemPrompt: "s", dataSources: [] }),
			),
		]);
		globalThis.fetch = gateway.fetch;

		await synthesize(icp, [], env);

		expect(modelInBody(gateway.calls[0])).toBe(env.MODEL_ROUTE_WORKER);
	});

	it("sends cf-aig-skip-cache on every call, including a retry", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(
				objectReply({ query: "q", systemPrompt: "s", dataSources: [] }),
			),
		]);
		globalThis.fetch = gateway.fetch;

		await synthesize(icp, [], env);

		expect(gateway.calls).toHaveLength(2);
		for (const call of gateway.calls) {
			expect(call.headers.get("cf-aig-skip-cache")).toBe("true");
		}
	});

	it("reports the gateway's returned cost on the ledger", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply(
					{ query: "q", systemPrompt: "s", dataSources: [] },
					0.0000042,
				),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(icp, [], env);

		expect(result.ledger.total()).toBeCloseTo(0.0000042, 12);
	});
});

describe("synthesize: cost recording without a cost field", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("records zero, not NaN or undefined, when the response body carries no usage.cost", async () => {
		const payload = {
			id: "chatcmpl-test",
			model: "deepseek/deepseek-v4-flash-0731",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: JSON.stringify({
							query: "q",
							systemPrompt: "s",
							dataSources: [],
						}),
					},
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 20, completion_tokens: 8 },
		};
		const response = new Response(JSON.stringify(payload), {
			status: 200,
			headers: {
				"content-type": "application/json",
				"cf-aig-model": "deepseek/deepseek-v4-flash-0731",
				"cf-aig-cache-status": "MISS",
			},
		});
		const gateway = fakeGateway([response]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(icp, [], env);

		expect(result.ledger.total()).toBe(0);
	});
});

describe("synthesize: data sources", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("drops a data source slug outside the closed enum", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({
					query: "q",
					systemPrompt: "s",
					dataSources: ["fiber", "totally-made-up", "similarweb"],
				}),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(icp, [], env);

		expect(result.dataSources).toEqual(["fiber", "similarweb"]);
	});

	it("never emits more than five data sources", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({
					query: "q",
					systemPrompt: "s",
					dataSources: [
						"fiber",
						"similarweb",
						"fiber",
						"similarweb",
						"fiber",
						"similarweb",
						"fiber",
					],
				}),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(icp, [], env);

		expect(result.dataSources).toHaveLength(5);
	});
});

describe("synthesize: prompt drift and retries", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps every core scoping term in the round-2 prompt after reject reasons are added", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({ query: "round-1", systemPrompt: "s", dataSources: [] }),
			),
			chatCompletionResponse(
				objectReply({ query: "round-2", systemPrompt: "s", dataSources: [] }),
			),
		]);
		globalThis.fetch = gateway.fetch;

		await synthesize(icp, [], env);
		await synthesize(
			icp,
			["stale evidence", "already seen", "no grounding"],
			env,
		);

		const roundOnePrompt = userContent(gateway.calls[0]);
		const roundTwoPrompt = userContent(gateway.calls[1]);
		expect(roundTwoPrompt).not.toBe(roundOnePrompt);
		for (const term of [icp.industry, icp.stage, icp.geography]) {
			expect(roundTwoPrompt).toContain(term);
		}
	});

	it("retries once after a schema failure and returns the retry's result", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(
				objectReply({
					query: "retry-query",
					systemPrompt: "retry-prompt",
					dataSources: ["fiber"],
				}),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(icp, [], env);

		expect(gateway.calls).toHaveLength(2);
		expect(result.query).toBe("retry-query");
		expect(result.systemPrompt).toBe("retry-prompt");
	});

	it("falls back to a template query after two consecutive failures, without throwing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(icp, [], env);

		expect(gateway.calls).toHaveLength(2);
		expect(result.dataSources).toEqual([]);
		expect(result.query).toContain(icp.industry);
		expect(result.query).toContain(icp.stage);
		expect(result.query).toContain(icp.geography);
	});
});
