import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Requirement } from "@/core/requirements";
import type { IcpDoc, SynthesizeInput } from "@/core/synthesize";
import { synthesize } from "@/core/synthesize";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse, fakeGateway } from "../support/fetch";

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

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
	pageQuery: string | null;
	userLocation: string | null;
};

function planReply(overrides: Partial<PlanShape> = {}, cost?: number) {
	const { route, query, angle, pageQuery, userLocation } = {
		route: null,
		query: "small US software teams that sell without a sales team",
		angle: "founder-led vertical software",
		pageQuery: null,
		userLocation: "US",
		...overrides,
	};
	return objectReply(
		{
			route,
			rounds: [{ angle, query, pageQuery }],
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

describe("the round runs on the route the requirements allow", () => {
	it("searches when nothing needs a page, ignoring an agent route the model asks for anyway", async () => {
		const chosen = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = chosen.fetch;
		const plain = await synthesize(recordOnlyInput(), fakeGatewayEnv());
		expect(plain.route).toBe("search");
		expect(plain.plans[0]?.source).toBe("exa-search");
		expect(plain.plans[0]?.recency).toBeNull();

		const overridden = fakeGateway([
			chatCompletionResponse(planReply({ route: "agent" })),
		]);
		globalThis.fetch = overridden.fetch;
		const ignored = await synthesize(recordOnlyInput(), fakeGatewayEnv());
		expect(ignored.route).toBe("search");
		expect(ignored.plans[0]?.source).toBe("exa-search");
	});

	it("carries the page requirement's evidence demand onto an agent round, and none onto a search one", async () => {
		const agentGateway = fakeGateway([
			chatCompletionResponse(planReply({ route: "agent" })),
		]);
		globalThis.fetch = agentGateway.fetch;
		const agentRound = await synthesize(pageGatedInput(), fakeGatewayEnv());
		expect(agentRound.route).toBe("agent");
		expect(agentRound.plans[0]?.source).toBe("exa-agent");
		expect(agentRound.plans[0]?.recency).toBe(pageRequirement.text);
		expect(agentRound.plans[0]?.eventWindowDays).toBe(30);

		const searchGateway = fakeGateway([
			chatCompletionResponse(planReply({ route: "search" })),
		]);
		globalThis.fetch = searchGateway.fetch;
		const searchRound = await synthesize(pageGatedInput(), fakeGatewayEnv());
		expect(searchRound.route).toBe("search");
		expect(searchRound.plans[0]?.recency).toBeNull();
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

		const result = await synthesize(pageGatedInput(), fakeGatewayEnv());

		expect(result.plans.map((plan) => plan.angle)).toEqual([
			"banking",
			"retail",
		]);
		expect(result.plans.every((plan) => plan.minWorkforce === 500)).toBe(true);
		expect(result.plans[1]?.pageQuery).toBe("a retail blog");
	});

	it("asks the model for as many angles as the round wants, and how many the last one proved", async () => {
		const angleCount = fakeGateway([chatCompletionResponse(planReply())]);
		globalThis.fetch = angleCount.fetch;
		await synthesize({ ...pageGatedInput(), angles: 6 }, fakeGatewayEnv());
		expect(userContent(angleCount.calls[0])).toContain(
			"Write 6 different angles",
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
