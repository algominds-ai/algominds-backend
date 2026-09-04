import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Requirement } from "../src/core/requirements";
import type { IcpDoc, SynthesizeInput } from "../src/core/synthesize";
import { synthesize } from "../src/core/synthesize";

const env: Env = {
	...testEnv,
	AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
	CF_AIG_TOKEN: { get: async () => "test-aig-token" },
	MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
	MODEL_ROUTE_WORKER: "dynamic/brain-worker",
};

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
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

function _systemContent(request: CapturedRequest | undefined): string {
	if (!request) throw new Error("expected a captured request");
	const body = RequestBodySchema.parse(request.body);
	const message = body.messages.find((entry) => entry.role === "system");
	if (!message)
		throw new Error("expected a system message in the request body");
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

type PlanShape = {
	route: string | null;
	query: string;
	angle: string;
	pageQuery: string | null;
	userLocation: string | null;
	countries: string[];
	minWorkforce: number | null;
	maxWorkforce: number | null;
	minFoundedYear: number | null;
	maxFoundedYear: number | null;
	minRevenueAnnual: number | null;
	maxRevenueAnnual: number | null;
	minFundingTotal: number | null;
	maxFundingTotal: number | null;
};

function planReply(overrides: Partial<PlanShape> = {}): ScriptedReply {
	const { route, query, angle, pageQuery, ...bounds } = {
		route: null,
		query: "small US software teams that sell without a sales team",
		angle: "founder-led vertical software",
		pageQuery: null,
		...overrides,
	};
	return objectReply({
		route,
		rounds: [{ angle, query, pageQuery }],
		userLocation: "US",
		countries: ["United States"],
		minWorkforce: null,
		maxWorkforce: 20,
		minFoundedYear: null,
		maxFoundedYear: null,
		minRevenueAnnual: null,
		maxRevenueAnnual: null,
		minFundingTotal: null,
		maxFundingTotal: null,
		...bounds,
	});
}

const recordRequirement: Requirement = {
	id: "r1",
	text: "the company has twenty employees or fewer and is based in the United States",
	kind: "hard",
	proof: "record",
	windowDays: null,
};

const pageRequirement: Requirement = {
	id: "r2",
	text: "the company published an engineering page showing it runs the platform itself",
	kind: "hard",
	proof: "page",
	windowDays: 30,
};

const testRequirements: Requirement[] = [recordRequirement];

function recordOnlyInput(): SynthesizeInput {
	return {
		icp,
		requirements: [recordRequirement],
		pastAngles: [],
		feedback: [],
		today: "2026-08-30",
		angles: 1,
		provenRate: null,
	};
}

function pageGatedInput(): SynthesizeInput {
	return {
		...recordOnlyInput(),
		requirements: [recordRequirement, pageRequirement],
	};
}

function runSynthesize(
	pastAngles: readonly string[] = [],
	feedback: readonly string[] = [],
) {
	return synthesize(
		{
			icp,
			requirements: testRequirements,
			pastAngles,
			feedback,
			today: "2026-08-30",
			angles: 1,
			provenRate: null,
		},
		env,
	);
}

describe("synthesize: gateway wiring", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends cf-aig-authorization and targets a URL under /compat", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		await runSynthesize();

		const call = gateway.calls[0];
		expect(call?.headers.get("cf-aig-authorization")).toBe(
			"Bearer test-aig-token",
		);
		expect(new URL(String(call?.url)).pathname).toContain("/compat");
	});

	it("runs on the reasoning route, because the plan now chooses the source", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		await runSynthesize();

		expect(modelInBody(gateway.calls[0])).toBe(env.MODEL_ROUTE_REASONING);
		expect(modelInBody(gateway.calls[0])).not.toBe(env.MODEL_ROUTE_WORKER);
	});

	it("sends cf-aig-skip-cache on every call, including a retry", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(planReply()),
		]);
		globalThis.fetch = gateway.fetch;

		await runSynthesize();

		expect(gateway.calls).toHaveLength(2);
		for (const call of gateway.calls) {
			expect(call.headers.get("cf-aig-skip-cache")).toBe("true");
		}
	});

	it("reports the gateway's returned cost on the ledger", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply(
					{
						route: null,
						rounds: [{ angle: "a", query: "q", pageQuery: null }],
						userLocation: null,
						countries: [],
						minWorkforce: null,
						maxWorkforce: null,
						minFoundedYear: null,
						maxFoundedYear: null,
						minRevenueAnnual: null,
						maxRevenueAnnual: null,
						minFundingTotal: null,
						maxFundingTotal: null,
					},
					0.0000042,
				),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await runSynthesize();

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
							route: null,
							rounds: [{ angle: "a", query: "q", pageQuery: null }],
							source: null,
							agentEffort: null,
							userLocation: null,
							countries: [],
							minWorkforce: null,
							maxWorkforce: null,
							minFoundedYear: null,
							maxFoundedYear: null,
							minRevenueAnnual: null,
							maxRevenueAnnual: null,
							minFundingTotal: null,
							maxFundingTotal: null,
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

		const result = await runSynthesize();

		expect(result.ledger.total()).toBe(0);
	});
});

describe("synthesize: the plan it returns", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns the model's query, angle, and numeric limits unchanged", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		const result = await runSynthesize();

		expect(result.plans[0]?.query).toBe(
			"small US software teams that sell without a sales team",
		);
		expect(result.plans[0]?.angle).toBe("founder-led vertical software");
		expect(result.plans[0]?.maxWorkforce).toBe(20);
		expect(result.plans[0]?.countries).toEqual(["United States"]);
	});

	it("uppercases a two-letter country code and drops anything else", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(planReply({ userLocation: "us" })),
			chatCompletionResponse(planReply({ userLocation: "United States" })),
		]);
		globalThis.fetch = gateway.fetch;

		expect((await runSynthesize()).plans[0]?.userLocation).toBe("US");
		expect((await runSynthesize()).plans[0]?.userLocation).toBeNull();
	});

	it("lists the angles already tried so the model picks a different one", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		await runSynthesize(["vertical dental software", "developer tooling"]);

		const prompt = userContent(gateway.calls[0]);
		expect(prompt).toContain("vertical dental software");
		expect(prompt).toContain("developer tooling");
	});
});

describe("synthesize: prompt drift and retries", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps the whole profile in the round-2 prompt after reject reasons are added", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(planReply({ query: "round-1" })),
			chatCompletionResponse(planReply({ query: "round-2" })),
		]);
		globalThis.fetch = gateway.fetch;

		await runSynthesize();
		await runSynthesize(["angle-1"], ["already seen", "headcount too high"]);

		const roundOnePrompt = userContent(gateway.calls[0]);
		const roundTwoPrompt = userContent(gateway.calls[1]);
		expect(roundTwoPrompt).not.toBe(roundOnePrompt);
		expect(roundTwoPrompt).toContain(recordRequirement.text);
		expect(roundTwoPrompt).toContain("headcount too high");
	});

	it("retries once after a schema failure and returns the retry's result", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(
				planReply({ query: "retry-query", angle: "retry-angle" }),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await runSynthesize();

		expect(gateway.calls).toHaveLength(2);
		expect(result.plans[0]?.query).toBe("retry-query");
		expect(result.plans[0]?.angle).toBe("retry-angle");
	});

	it("falls back to a template query after two consecutive failures, without throwing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await runSynthesize();

		expect(gateway.calls).toHaveLength(2);
		expect(result.plans[0]?.query).toBe(icp.description);
		expect(result.plans[0]?.maxWorkforce).toBeNull();
		expect(result.plans[0]?.countries).toEqual([]);
	});

	it("falls back onto the agent route with its evidence demand carried, never a plan the round would think proved nothing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(pageGatedInput(), env);

		expect(result.route).toBe("agent");
		expect(result.plans[0]?.source).toBe("exa-agent");
		expect(result.plans[0]?.recency).toBe(pageRequirement.text);
		expect(result.plans[0]?.recencyDays).toBe(30);
	});
});

describe("the round runs on the route the requirements allow", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("searches when nothing in the profile needs a page to settle it", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(recordOnlyInput(), env);

		expect(result.route).toBe("search");
		expect(result.plans[0]?.source).toBe("exa-search");
		expect(result.plans[0]?.recency).toBeNull();
		expect(result.plans[0]?.recencyDays).toBeNull();
	});

	it("ignores an agent route the model asks for when no requirement needs a page", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(planReply({ route: "agent" })),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(recordOnlyInput(), env);

		expect(result.route).toBe("search");
		expect(result.plans[0]?.source).toBe("exa-search");
	});

	it("carries the page requirement and its window onto an agent round", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(planReply({ route: "agent" })),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(pageGatedInput(), env);

		expect(result.route).toBe("agent");
		expect(result.plans[0]?.source).toBe("exa-agent");
		expect(result.plans[0]?.recency).toBe(pageRequirement.text);
		expect(result.plans[0]?.recencyDays).toBe(30);
		expect(result.plans[0]?.eventWindowDays).toBe(30);
	});

	it("leaves a page-gated round on search when the model chooses it, and demands nothing of the agent", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(planReply({ route: "search" })),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(pageGatedInput(), env);

		expect(result.route).toBe("search");
		expect(result.plans[0]?.source).toBe("exa-search");
		expect(result.plans[0]?.recency).toBeNull();
	});

	it("returns one plan per angle the model wrote, sharing the round's bounds", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({
					route: "agent",
					rounds: [
						{ angle: "banking", query: "banks", pageQuery: "a bank blog" },
						{ angle: "retail", query: "retailers", pageQuery: "a retail blog" },
					],
					userLocation: "US",
					countries: ["United States"],
					minWorkforce: 500,
					maxWorkforce: null,
					minFoundedYear: null,
					maxFoundedYear: null,
					minRevenueAnnual: null,
					maxRevenueAnnual: null,
					minFundingTotal: null,
					maxFundingTotal: null,
				}),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await synthesize(pageGatedInput(), env);

		expect(result.plans).toHaveLength(2);
		expect(result.plans.map((plan) => plan.angle)).toEqual([
			"banking",
			"retail",
		]);
		expect(result.plans.every((plan) => plan.minWorkforce === 500)).toBe(true);
		expect(result.plans[1]?.pageQuery).toBe("a retail blog");
	});

	it("asks the model for as many angles as the round wants", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		await synthesize({ ...pageGatedInput(), angles: 6 }, env);

		expect(userContent(gateway.calls[0])).toContain("Write 6 different angles");
	});

	it("tells the next round how many candidates the last one proved", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		await synthesize({ ...pageGatedInput(), provenRate: "3 of 20" }, env);

		expect(userContent(gateway.calls[0])).toContain("3 of 20");
	});
});
