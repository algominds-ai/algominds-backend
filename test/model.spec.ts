import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CostLedger } from "../src/core/cost";
import {
	generateStructured,
	reasoningModel,
	workerModel,
} from "../src/core/model";
import { RetryableProviderError } from "../src/core/providers/waterfall";

const env: Env = {
	...testEnv,
	AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
	CF_AIG_TOKEN: { get: async () => "test-aig-token" },
	MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
	MODEL_ROUTE_WORKER: "dynamic/brain-worker",
};

const WidgetSchema = z.object({ widgetName: z.string(), count: z.number() });

type CapturedRequest = { url: string; body: unknown };

const StructuredRequestBodySchema = z.object({
	model: z.string(),
	response_format: z.object({
		type: z.string(),
		json_schema: z
			.object({
				schema: z
					.object({
						properties: z.object({ widgetName: z.unknown() }).passthrough(),
					})
					.passthrough(),
			})
			.optional(),
	}),
	provider: z
		.object({ require_parameters: z.boolean(), sort: z.string().optional() })
		.optional(),
});

function capturedBody(
	request: CapturedRequest | undefined,
): z.infer<typeof StructuredRequestBodySchema> {
	if (!request) throw new Error("expected a captured request");
	return StructuredRequestBodySchema.parse(request.body);
}

type ScriptedReply = {
	content: string;
	finishReason?: "stop" | "length";
	cost?: number;
	cacheStatus?: "HIT" | "MISS";
};

function chatCompletionResponse(reply: ScriptedReply): Response {
	const model = "deepseek/deepseek-v4-flash-0731";
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
			"cf-aig-cache-status": reply.cacheStatus ?? "MISS",
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
		calls.push({ url: String(input), body });
		const response = responses[index];
		index += 1;
		if (!response)
			throw new Error(`fakeGateway: no scripted response for call ${index}`);
		return response;
	};
	return { fetch: handler, calls };
}

function widgetReply(
	overrides: { cost?: number; cacheStatus?: "HIT" | "MISS" } = {},
): ScriptedReply {
	return {
		content: JSON.stringify({ widgetName: "Acme Widget", count: 3 }),
		...overrides,
	};
}

async function callWorkerModel(ledger: CostLedger) {
	const model = await workerModel(env);
	return generateStructured(
		{
			model,
			configuredId: env.MODEL_ROUTE_WORKER,
			instructions: "pick a widget",
			prompt: "name one widget",
			schema: WidgetSchema,
			headers: {},
		},
		ledger,
		"test-op",
	);
}

async function callReasoningModel(ledger: CostLedger) {
	const model = await reasoningModel(env);
	return generateStructured(
		{
			model,
			configuredId: env.MODEL_ROUTE_REASONING,
			instructions: "pick a widget",
			prompt: "name one widget",
			schema: WidgetSchema,
			headers: {},
		},
		ledger,
		"test-op",
	);
}

describe("model: the request body the SDK sends", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("carries the real JSON schema in response_format, not a bare json_object", async () => {
		const gateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = gateway.fetch;

		await callWorkerModel(new CostLedger());

		const body = capturedBody(gateway.calls[0]);
		expect(body.response_format.type).toBe("json_schema");
		expect(body.response_format.json_schema?.schema.properties).toEqual({
			widgetName: { type: "string" },
			count: { type: "number" },
		});
	});

	it("carries the OpenRouter routing flag that makes a provider honour the schema", async () => {
		const gateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = gateway.fetch;

		await callWorkerModel(new CostLedger());

		expect(capturedBody(gateway.calls[0]).provider?.require_parameters).toBe(
			true,
		);
	});

	it("never asks for the fastest provider, because that one accepts the schema and ignores it", async () => {
		const gateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = gateway.fetch;

		await callWorkerModel(new CostLedger());

		expect(capturedBody(gateway.calls[0]).provider?.sort).toBeUndefined();
	});

	it("targets the worker route for the lighter model", async () => {
		const gateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = gateway.fetch;

		await callWorkerModel(new CostLedger());

		expect(capturedBody(gateway.calls[0]).model).toBe(env.MODEL_ROUTE_WORKER);
	});

	it("targets the reasoning route for the stronger model", async () => {
		const gateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = gateway.fetch;

		await callReasoningModel(new CostLedger());

		expect(capturedBody(gateway.calls[0]).model).toBe(
			env.MODEL_ROUTE_REASONING,
		);
	});
});

describe("model: a response that never matches the schema", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("retries once, then returns null rather than throwing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await callWorkerModel(new CostLedger());

		expect(gateway.calls).toHaveLength(2);
		expect(result).toBeNull();
	});

	it("returns the retry's result after one schema failure", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(widgetReply()),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await callWorkerModel(new CostLedger());

		expect(gateway.calls).toHaveLength(2);
		expect(result?.widgetName).toBe("Acme Widget");
	});
});

describe("model: a call that exceeds the shared timeout", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("throws so the durable step's own retry owns it, rather than resolving as an empty reply", async () => {
		globalThis.fetch = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};

		await expect(callWorkerModel(new CostLedger())).rejects.toThrow(
			RetryableProviderError,
		);
	});
});

describe("model: cost reporting", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("records the cost the gateway returned onto the ledger", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(widgetReply({ cost: 0.0000042 })),
		]);
		globalThis.fetch = gateway.fetch;
		const ledger = new CostLedger();

		await callWorkerModel(ledger);

		expect(ledger.total()).toBeCloseTo(0.0000042, 12);
	});

	it("records zero on a cache hit, not the gateway's stale reported cost", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				widgetReply({ cost: 0.0000042, cacheStatus: "HIT" }),
			),
		]);
		globalThis.fetch = gateway.fetch;
		const ledger = new CostLedger();

		await callWorkerModel(ledger);

		expect(ledger.total()).toBe(0);
	});
});
