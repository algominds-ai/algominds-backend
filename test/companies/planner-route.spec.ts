import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Requirement } from "@/core/requirements";
import type { IcpDoc, SynthesizeInput } from "@/core/synthesize";
import { synthesize } from "@/core/synthesize";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse, fakeGateway } from "../support/fetch";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture(
	{ offer: "Fintech software", buyer: "Revenue leaders" },
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

function objectReply(value: unknown, cost?: number) {
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

function planReply(overrides: Partial<PlanShape> = {}, cost?: number) {
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

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("the round respects the planner route", () => {
	it("defaults to search and preserves an agent choice even without a dated condition", async () => {
		const chosen = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = chosen.fetch;
		const plain = await synthesize(recordOnlyInput(), fakeGatewayEnv());
		expect(plain.route).toBe("search");
		expect(plain.plans[0]?.source).toBe("exa-search");

		const overridden = fakeGateway([
			chatCompletionResponse(planReply({ route: "agent" })),
		]);
		globalThis.fetch = overridden.fetch;
		const researched = await synthesize(recordOnlyInput(), fakeGatewayEnv());
		expect(researched.route).toBe("agent");
		expect(researched.plans[0]?.source).toBe("exa-agent");
		expect(researched.plans[0]?.agentEffort).toBe("minimal");
	});

	it("preserves the requirement in the planner input regardless of chosen route", async () => {
		const agentGateway = fakeGateway([
			chatCompletionResponse(planReply({ route: "agent" })),
		]);
		globalThis.fetch = agentGateway.fetch;
		const agentRound = await synthesize(pageGatedInput(), fakeGatewayEnv());
		expect(agentRound.route).toBe("agent");
		expect(agentRound.plans[0]?.source).toBe("exa-agent");
		expect(JSON.stringify(agentGateway.calls[0]?.body)).toContain(
			pageRequirement.anyOf[0]?.allOf[0]?.text,
		);

		const searchGateway = fakeGateway([
			chatCompletionResponse(planReply({ route: "search" })),
		]);
		globalThis.fetch = searchGateway.fetch;
		const searchRound = await synthesize(pageGatedInput(), fakeGatewayEnv());
		expect(searchRound.route).toBe("search");
	});

	it("keeps up to the requested agent angles and shares the round's bounds", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({
					route: "agent",
					rounds: [
						{ angle: "banking", query: "banks" },
						{ angle: "retail", query: "retailers" },
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

		const result = await synthesize(
			{ ...pageGatedInput(), angles: 2 },
			fakeGatewayEnv(),
		);

		expect(result.plans.map((plan) => plan.angle)).toEqual([
			"banking",
			"retail",
		]);
		expect(result.plans.every((plan) => plan.minWorkforce === 500)).toBe(true);
	});
});

describe("the planner bounds its generated angles", () => {
	it("keeps one search angle even when the model writes several", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({
					route: "search",
					rounds: [
						{ angle: "banking", query: "banks" },
						{ angle: "retail", query: "retailers" },
					],
					userLocation: "US",
					countries: ["United States"],
					minWorkforce: null,
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

		const result = await synthesize(pageGatedInput(), fakeGatewayEnv());

		expect(result.route).toBe("search");
		expect(result.plans.map((plan) => plan.angle)).toEqual(["banking"]);
	});

	it("asks the model for as many angles as the round wants, and how many the last one proved", async () => {
		const angleCount = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = angleCount.fetch;
		await synthesize({ ...pageGatedInput(), angles: 6 }, fakeGatewayEnv());
		expect(userContent(angleCount.calls[0])).toContain(
			"up to 6 different agent angles",
		);

		const provenRate = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = provenRate.fetch;
		await synthesize(
			{ ...pageGatedInput(), provenRate: "3 of 20" },
			fakeGatewayEnv(),
		);
		expect(userContent(provenRate.calls[0])).toContain("3 of 20");
	});
});
