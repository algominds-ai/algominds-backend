import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { config } from "@/config";
import { buildAgentRunRequest } from "@/core/companies/agent-search";
import { CostLedger } from "@/core/cost";
import type { SearchPlan } from "@/core/synthesize";
import { AGENT_EFFORTS } from "@/core/synthesize";
import { agentFanout } from "@/workflows/find-companies-agent";
import { fakeSecretEnv } from "../support/env";
import { fakeExaAgentRun } from "../support/fetch";
import { profileFixture } from "../support/icp";
import { fakeWorkflowStep } from "../support/step";

function planFor(query: string, band?: Partial<SearchPlan>): SearchPlan {
	return {
		query,
		angle: "angle-1",
		source: "exa-agent",
		agentEffort: "low",
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
		...band,
	};
}

function fanoutFor(
	step: ReturnType<typeof fakeWorkflowStep>["step"],
	icp: Parameters<typeof agentFanout>[0]["icp"] = profileFixture(),
) {
	return agentFanout({
		step,
		round: 1,
		remaining: 15,
		today: "2026-08-30",
		icp,
		runId: "test-run-1",
	});
}

const AgentRunBodySchema = z.object({
	query: z.string(),
	systemPrompt: z.string(),
	input: z.object({ exclusion: z.array(z.object({ website: z.string() })) }),
	outputSchema: z.object({
		properties: z.object({
			companies: z.object({
				minItems: z.number().optional(),
				maxItems: z.number(),
			}),
		}),
	}),
});

function startedRequests(started: { body: unknown }[]) {
	return started.map((entry) => {
		const body = AgentRunBodySchema.parse(entry.body);
		return {
			query: body.query,
			exclusion: body.input.exclusion,
			systemPrompt: body.systemPrompt,
			minItems: body.outputSchema.properties.companies.minItems,
			maxItems: body.outputSchema.properties.companies.maxItems,
		};
	});
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("one agent round fans out across the angles the planner wrote", () => {
	it("starts one run per angle, merging what every angle found", async () => {
		const { fetch, started } = fakeExaAgentRun({
			structured: { companies: [] },
		});
		globalThis.fetch = fetch;
		const fanout = fanoutFor(fakeWorkflowStep().step);

		await fanout(
			[
				planFor("US managed service providers"),
				planFor("EU payment platforms"),
			],
			[],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		const requests = startedRequests(started);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.query).toContain("US managed service providers");
		expect(requests[1]?.query).toContain("EU payment platforms");
		expect(requests[0]?.query).toContain("angle-1");
	});

	it("asks each angle for the configured companies per angle, never the whole count", async () => {
		const { fetch, started } = fakeExaAgentRun({
			structured: { companies: [] },
		});
		globalThis.fetch = fetch;
		const fanout = fanoutFor(fakeWorkflowStep().step);

		await fanout(
			[planFor("seed stage fintech")],
			[],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		const perAngle = 15;
		const request = startedRequests(started)[0];
		expect(request?.query).toContain(`Return up to ${perAngle} distinct`);
		expect(request?.minItems).toBeUndefined();
		expect(request?.maxItems).toBe(perAngle);
	});

	it("waits between angle starts, so a fan-out never crosses the vendor's per-second limit", async () => {
		globalThis.fetch = fakeExaAgentRun({ structured: { companies: [] } }).fetch;
		const staggering = fakeWorkflowStep();
		const fanout = fanoutFor(staggering.step);

		await fanout(
			[planFor("angle one"), planFor("angle two"), planFor("angle three")],
			[],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(staggering.sleepCalls.map((call) => call.name)).toEqual([
			"round_1-angle_1-stagger",
			"round_1-angle_2-stagger",
		]);
	});
});

describe("what one angle's request tells the vendor", () => {
	it("carries exclusions without adding the plan's flat record bounds to research", async () => {
		const { fetch, started } = fakeExaAgentRun({
			structured: { companies: [] },
		});
		globalThis.fetch = fetch;
		const fanout = fanoutFor(fakeWorkflowStep().step);

		await fanout(
			[
				planFor("B2B software with an outbound team", {
					minWorkforce: 10,
					maxWorkforce: 300,
					countries: ["United States"],
				}),
			],
			["seen.com", "known.io"],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		const request = startedRequests(started)[0];
		expect(request?.exclusion).toEqual([
			{ website: "seen.com" },
			{ website: "known.io" },
		]);
		expect(request?.query).not.toContain("Every company must");
	});

	it("carries only scoped seller context and intact company requirements into the started run", async () => {
		const { fetch, started } = fakeExaAgentRun({
			structured: { companies: [] },
		});
		globalThis.fetch = fetch;
		const profile = profileFixture(
			{ offer: "Trust Fabric workload identity" },
			"Target platform engineers, not payments buyers",
		);
		profile.seller = {
			domain: "form3.tech",
			customers: ["Klarna"],
			description: "payment infrastructure for banks",
			sourceUrls: [],
		};
		const fanout = fanoutFor(fakeWorkflowStep().step, profile);

		await fanout(
			[planFor("large European platform teams")],
			[],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		const request = startedRequests(started)[0];
		expect(request?.systemPrompt).toContain("form3.tech");
		expect(request?.systemPrompt).toContain(profile.seller.description);
		expect(request?.systemPrompt).toContain(profile.icp.offer ?? "");
		expect(request?.systemPrompt).toContain(
			JSON.stringify(profile.icp.requirements),
		);
		expect(request?.systemPrompt).not.toContain(
			"Target platform engineers, not payments buyers",
		);
		expect(request?.systemPrompt).not.toContain("Klarna");
	});
});

describe("the poll interval scales with the angles in flight", () => {
	it("polls a twelve-angle fan-out every 6 seconds, keeping a single-angle round at the base 5", async () => {
		globalThis.fetch = fakeExaAgentRun({
			completeAfterPolls: 2,
			structured: { companies: [] },
		}).fetch;
		const twelve = fakeWorkflowStep();
		const plans = Array.from({ length: 12 }, (_, index) =>
			planFor(`angle ${index}`),
		);
		await fanoutFor(twelve.step)(
			plans,
			[],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);
		const twelveWaits = twelve.sleepCalls.filter((call) =>
			call.name.includes("-wait-"),
		);
		expect(twelveWaits.length).toBeGreaterThan(0);
		for (const wait of twelveWaits) expect(wait.duration).toBe("6 seconds");

		globalThis.fetch = fakeExaAgentRun({
			completeAfterPolls: 2,
			structured: { companies: [] },
		}).fetch;
		const single = fakeWorkflowStep();
		await fanoutFor(single.step)(
			[planFor("angle one")],
			[],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);
		const singleWaits = single.sleepCalls.filter((call) =>
			call.name.includes("-wait-"),
		);
		expect(singleWaits.length).toBeGreaterThan(0);
		for (const wait of singleWaits) expect(wait.duration).toBe("5 seconds");
	});
});

describe("a round whose agent finds nothing counts as an empty round, not a failure", () => {
	it("resolves to zero results and banks the run's cost, instead of throwing", async () => {
		globalThis.fetch = fakeExaAgentRun({
			structured: { companies: null },
			costDollars: { total: 0.012, agentCompute: 0.012 },
		}).fetch;
		const ledger = new CostLedger();
		const fanout = fanoutFor(fakeWorkflowStep().step);

		const result = await fanout(
			[planFor("payment platforms serving credit unions")],
			[],
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			ledger,
		);

		expect(result.results).toEqual([]);
		expect(ledger.total()).toBeCloseTo(0.012, 5);
	});
});

describe("the request schema Exa's agent actually accepts", () => {
	it("sends an output schema with no $schema key and no pattern anywhere, and the configured effort", () => {
		for (const agentEffort of AGENT_EFFORTS) {
			const request = buildAgentRunRequest({
				plan: planFor("US managed service providers", { agentEffort }),
				count: 15,
				today: "2026-09-02",
				icp: profileFixture(),
				excludeDomains: [],
			});
			const schema = JSON.parse(JSON.stringify(request.outputSchema));
			expect(schema).not.toHaveProperty("$schema");
			expect(JSON.stringify(schema)).not.toContain('"pattern"');
			expect(request.effort).toBe(agentEffort);
		}

		const request = buildAgentRunRequest({
			plan: planFor("US managed service providers"),
			count: 15,
			today: "2026-09-02",
			icp: profileFixture(),
			excludeDomains: [],
		});
		const schema = JSON.parse(JSON.stringify(request.outputSchema));
		expect(request.dataSources).toBeUndefined();
		expect(schema.properties.companies.maxItems).toBe(15);
		expect(Object.keys(schema.properties.companies.items.properties)).toEqual([
			"name",
			"website",
			"linkedinUrl",
			"description",
			"evidence",
		]);
		expect(schema.properties.companies.items.properties).not.toHaveProperty(
			"workforceTotal",
		);
		expect(schema.properties.companies.items.properties).not.toHaveProperty(
			"fundingTotal",
		);
	});
});

describe("the judge step's own retry budget", () => {
	it("uses the configured retry budget for a failed judge step", () => {
		expect(config.stepConfig.judgeCall.retries.limit).toBe(1);
	});
});

describe("a round's own retry budget", () => {
	it("never retries a failed round, since a retry reruns every nested step including synthesize and search", () => {
		expect(config.stepConfig.roundCall.retries.limit).toBe(0);
	});
});
