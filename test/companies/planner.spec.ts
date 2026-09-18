import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Requirement } from "@/core/requirements";
import type { IcpDoc, SynthesizeInput } from "@/core/synthesize";
import { synthesize } from "@/core/synthesize";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse, fakeGateway } from "../support/fetch";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture(
	{
		offer: "Fintech software",
		buyer: "Revenue leaders",
	},
	"Find fintech companies at seed stage in San Francisco with a small team.",
);

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function userContent(call: { body: unknown } | undefined): string {
	if (!call) throw new Error("expected a captured request");
	const body = RequestBodySchema.parse(call.body);
	const message = body.messages.find((entry) => entry.role === "user");
	if (!message) throw new Error("expected a user message");
	return message.content;
}

function modelOf(call: { body: unknown } | undefined): string {
	if (!call) throw new Error("expected a captured request");
	return RequestBodySchema.parse(call.body).model;
}

function objectReply(value: unknown, cost?: number | null) {
	return cost === undefined
		? { content: JSON.stringify(value) }
		: { content: JSON.stringify(value), cost };
}

type PlanShape = {
	route: string | null;
	query: string;
	angle: string;
	userLocation: string | null;
};

function planReply(overrides: Partial<PlanShape> = {}, cost?: number | null) {
	const { route, query, angle, userLocation } = {
		route: null,
		query: "small US software teams that sell without a sales team",
		angle: "founder-led vertical software",
		userLocation: "US",
		...overrides,
	};
	return objectReply(
		{
			route,
			rounds: [{ angle, query }],
			userLocation,
			countries: ["United States"],
			minWorkforce: null,
			maxWorkforce: 20,
			minFoundedYear: null,
			maxFoundedYear: null,
			minRevenueAnnual: null,
			maxRevenueAnnual: null,
			minFundingTotal: null,
			maxFundingTotal: null,
		},
		cost,
	);
}

const recordRequirement: Requirement = requirementFixture(
	"the company has twenty employees or fewer and is based in the United States",
);

const pageRequirement: Requirement = {
	kind: "required",
	anyOf: [
		{
			allOf: [
				{
					text: "the company published an engineering page showing it runs the platform itself",
					window: {
						amount: 30,
						unit: "days",
						appliesTo: "publication",
						direction: "past",
					},
					sourceRule: "company domain",
				},
			],
		},
	],
};

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
		{ ...recordOnlyInput(), pastAngles, feedback },
		fakeGatewayEnv(),
	);
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("synthesize: gateway wiring", () => {
	it("sends cf-aig-authorization to /compat, on the reasoning route, never the worker route", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;
		const env = fakeGatewayEnv();

		await synthesize(recordOnlyInput(), env);

		const call = gateway.calls[0];
		expect(call?.headers.get("cf-aig-authorization")).toBe(
			"Bearer test-aig-token",
		);
		expect(new URL(String(call?.url)).pathname).toContain("/compat");
		expect(modelOf(call)).toBe(env.MODEL_ROUTE_REASONING);
		expect(modelOf(call)).not.toBe(env.MODEL_ROUTE_WORKER);
		expect(call?.body).toMatchObject({
			reasoning: { effort: "low" },
			provider: { require_parameters: true },
			response_format: { type: "json_schema" },
		});
	});

	it("sends cf-aig-skip-cache on the single paid call", async () => {
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		await runSynthesize();

		expect(gateway.calls).toHaveLength(1);
		for (const call of gateway.calls) {
			expect(call.headers.get("cf-aig-skip-cache")).toBe("true");
		}
	});

	it("reports the gateway's returned cost on the ledger, zero when the body carries none", async () => {
		const withCost = fakeGateway([
			chatCompletionResponse(planReply({}, 0.0000042)),
		]);
		globalThis.fetch = withCost.fetch;
		expect((await runSynthesize()).ledger.total()).toBeCloseTo(0.0000042, 12);

		const withoutCost = fakeGateway([
			chatCompletionResponse(planReply({}, null)),
		]);
		globalThis.fetch = withoutCost.fetch;
		expect((await runSynthesize()).ledger.total()).toBe(0);
	});
});

describe("synthesize: the plan it returns", () => {
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
		const lower = fakeGateway([
			chatCompletionResponse(planReply({ userLocation: "us" })),
		]);
		globalThis.fetch = lower.fetch;
		expect((await runSynthesize()).plans[0]?.userLocation).toBe("US");

		const invalid = fakeGateway([
			chatCompletionResponse(planReply({ userLocation: "United States" })),
		]);
		globalThis.fetch = invalid.fetch;
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
	it("passes only the company projection at the planner boundary", async () => {
		const scoped = profileFixture(
			{ offer: "Trust Fabric", buyer: "Platform leaders" },
			"RAW NOTE: target only the security owner",
			"form3.tech",
		);
		scoped.seller.description = "payments infrastructure seller";
		const gateway = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = gateway.fetch;

		await synthesize(
			{
				...recordOnlyInput(),
				icp: scoped,
				requirements: [recordRequirement],
			},
			fakeGatewayEnv(),
		);

		const prompt = userContent(gateway.calls[0]);
		expect(prompt).toContain("Seller: payments infrastructure seller");
		expect(prompt).toContain("Offer in scope: Trust Fabric");
		expect(prompt).toContain(JSON.stringify([recordRequirement]));
		expect(prompt).not.toContain("RAW NOTE");
		expect(prompt).not.toContain("Platform leaders");
	});

	it("keeps the requirement text in the round-2 prompt after reject reasons are added", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(planReply({ query: "round-1" })),
			chatCompletionResponse(planReply({ query: "round-2" })),
		]);
		globalThis.fetch = gateway.fetch;

		await runSynthesize();
		await runSynthesize(["angle-1"], ["already seen", "headcount too high"]);

		const roundTwoPrompt = userContent(gateway.calls[1]);
		expect(roundTwoPrompt).not.toBe(userContent(gateway.calls[0]));
		expect(roundTwoPrompt).toContain(
			recordRequirement.anyOf[0]?.allOf[0]?.text,
		);
		expect(roundTwoPrompt).toContain("headcount too high");
	});

	it("falls back after a schema failure without a second paid call", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await runSynthesize();

		expect(gateway.calls).toHaveLength(1);
		expect(result.plans[0]?.query).toContain(icp.icp.offer ?? "");
		expect(result.plans[0]?.query).toContain(
			JSON.stringify([recordRequirement]),
		);
		expect(result.plans[0]?.query).not.toContain("Revenue leaders");
	});

	it("falls back to a template query on the profile's own route after two consecutive failures", async () => {
		const searchGateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = searchGateway.fetch;
		const searchResult = await runSynthesize();
		expect(searchResult.plans[0]?.query).toContain(icp.icp.offer ?? "");
		expect(searchResult.plans[0]?.maxWorkforce).toBeNull();

		const agentGateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = agentGateway.fetch;
		const agentResult = await synthesize(pageGatedInput(), fakeGatewayEnv());
		expect(agentResult.route).toBe("agent");
		expect(agentResult.plans[0]?.source).toBe("exa-agent");
		expect(agentResult.plans[0]?.query).toContain(
			"the company published an engineering page",
		);
	});
});
