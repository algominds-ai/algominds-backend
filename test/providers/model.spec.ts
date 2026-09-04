import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { config } from "../../src/config";
import { CostLedger } from "../../src/core/cost";
import {
	generateStructured,
	reasoningModel,
	workerModel,
} from "../../src/core/model";
import { EXA_FETCH_TIMEOUT_MS } from "../../src/core/providers/exa/http";
import { RetryableProviderError } from "../../src/core/providers/waterfall";
import { fakeSecretEnv } from "../support/env";
import {
	chatCompletionResponse,
	fakeGateway,
	throwsTimeout,
} from "../support/fetch";

const env: Env = {
	...testEnv,
	...fakeSecretEnv({ CF_AIG_TOKEN: "test-aig-token" }),
	AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
	MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
	MODEL_ROUTE_WORKER: "dynamic/brain-worker",
};

const WidgetSchema = z.object({ widgetName: z.string(), count: z.number() });

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
	request: { body: unknown } | undefined,
): z.infer<typeof StructuredRequestBodySchema> {
	if (!request) throw new Error("expected a captured request");
	return StructuredRequestBodySchema.parse(request.body);
}

function widgetReply(
	overrides: { cost?: number; cacheStatus?: "HIT" | "MISS" } = {},
) {
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

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("model: the request body the SDK sends", () => {
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

	it("requires the schema's parameters and never asks for the fastest provider", async () => {
		const gateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = gateway.fetch;

		await callWorkerModel(new CostLedger());

		const body = capturedBody(gateway.calls[0]);
		expect(body.provider?.require_parameters).toBe(true);
		expect(body.provider?.sort).toBeUndefined();
	});

	it("targets the worker route for the lighter model and the reasoning route for the stronger one", async () => {
		const workerGateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = workerGateway.fetch;
		await callWorkerModel(new CostLedger());
		expect(capturedBody(workerGateway.calls[0]).model).toBe(
			env.MODEL_ROUTE_WORKER,
		);

		const reasoningGateway = fakeGateway([
			chatCompletionResponse(widgetReply()),
		]);
		globalThis.fetch = reasoningGateway.fetch;
		await callReasoningModel(new CostLedger());
		expect(capturedBody(reasoningGateway.calls[0]).model).toBe(
			env.MODEL_ROUTE_REASONING,
		);
	});
});

describe("model: a response that never matches the schema", () => {
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
	it("throws so the durable step's own retry owns it, rather than resolving as an empty reply", async () => {
		globalThis.fetch = throwsTimeout();

		await expect(callWorkerModel(new CostLedger())).rejects.toThrow(
			RetryableProviderError,
		);
	});
});

describe("model: the abort timeout a structured call is given", () => {
	it("aborts at the configured model timeout, not the shorter Exa fetch timeout", async () => {
		const gateway = fakeGateway([chatCompletionResponse(widgetReply())]);
		globalThis.fetch = gateway.fetch;
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

		await callWorkerModel(new CostLedger());

		expect(timeoutSpy).toHaveBeenCalledWith(config.model.timeoutMs);
		expect(config.model.timeoutMs).not.toBe(EXA_FETCH_TIMEOUT_MS);
		timeoutSpy.mockRestore();
	});
});

describe("model: cost reporting", () => {
	it("records the cost the gateway returned onto the ledger, and zero on a cache hit", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(widgetReply({ cost: 0.0000042 })),
		]);
		globalThis.fetch = gateway.fetch;
		const spent = new CostLedger();
		await callWorkerModel(spent);
		expect(spent.total()).toBeCloseTo(0.0000042, 12);

		const cachedGateway = fakeGateway([
			chatCompletionResponse(
				widgetReply({ cost: 0.0000042, cacheStatus: "HIT" }),
			),
		]);
		globalThis.fetch = cachedGateway.fetch;
		const cached = new CostLedger();
		await callWorkerModel(cached);
		expect(cached.total()).toBe(0);
	});
});
