import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { CostLedger } from "../src/core/cost";
import type { SearchPlan } from "../src/core/synthesize";
import { agentSearch } from "../src/workflows/find-companies-agent";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function planFor(query: string, band?: Partial<SearchPlan>): SearchPlan {
	return {
		query,
		angle: "angle-1",
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
		source: "exa-search",
		type: "fast",
		agentEffort: "low",
		additionalQueries: [],
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

function exaEnv(): Env {
	return { ...testEnv, EXA_API_KEY: { get: async () => "test-exa-key" } };
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

type StartedRun = { query: string; systemPrompt: string; minItems: number };

function stubAgentCompanyFetch(): { started: StartedRun[] } {
	const started: StartedRun[] = [];
	globalThis.fetch = async (input, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			started.push({
				query: String(body.query),
				systemPrompt: String(body.systemPrompt),
				minItems: Number(body.outputSchema?.properties?.companies?.minItems),
			});
			return jsonResponse({ id: `run-${started.length}`, status: "running" });
		}
		const id = String(input).split("/").pop();
		return jsonResponse({
			id,
			object: "agent_run",
			status: "completed",
			stopReason: "schema_satisfied",
			output: { text: "done", structured: { companies: [] } },
			costDollars: { total: 0.01, agentCompute: 0.01 },
		});
	};
	return { started };
}

function stubAgentCompanyFetchReportingNull(): void {
	globalThis.fetch = async (input, init) => {
		if (init?.method === "POST") {
			return jsonResponse({ id: "run-null-companies", status: "running" });
		}
		const id = String(input).split("/").pop();
		return jsonResponse({
			id,
			object: "agent_run",
			status: "completed",
			stopReason: "schema_satisfied",
			output: { text: "no companies matched", structured: { companies: null } },
			costDollars: { total: 0.012, agentCompute: 0.012 },
		});
	};
}

function fakeWorkflowStep(): WorkflowStep {
	async function runNamed(
		name: string,
		second: unknown,
		third: unknown,
	): Promise<unknown> {
		const callback = typeof second === "function" ? second : third;
		if (typeof callback !== "function") {
			throw new Error(`fake step: no callback for ${name}`);
		}
		const ctx: WorkflowStepContext = {
			step: { name, count: 0 },
			attempt: 1,
			config: {},
		};
		return callback(ctx);
	}
	return {
		do: runNamed,
		sleep: async () => undefined,
		sleepUntil: async () => undefined,
		waitForEvent: async () => {
			throw new Error("fake step: waitForEvent not implemented");
		},
	};
}

describe("the company agent run asks for more candidates than the caller wants", () => {
	it("asks the agent for the multiple the judge stage slices down to", async () => {
		const { started } = stubAgentCompanyFetch();
		const remaining = 1;

		const search = agentSearch({
			step: fakeWorkflowStep(),
			round: 1,
			remaining: remaining,
			today: "2026-08-30",
			seller: null,
		});
		await search(
			planFor("small US software teams"),
			{ query: "small US software teams" },
			exaEnv(),
			new CostLedger(),
		);

		const wanted = remaining * config.companies.judgeCandidateMultiple;
		expect(started).toHaveLength(1);
		expect(started[0]?.minItems).toBe(1);
		expect(started[0]?.query).toContain(`${wanted} distinct companies`);
	});

	it("keeps the funnel wider than the ask for a larger request too", async () => {
		const { started } = stubAgentCompanyFetch();
		const remaining = 4;

		const search = agentSearch({
			step: fakeWorkflowStep(),
			round: 1,
			remaining: remaining,
			today: "2026-08-30",
			seller: null,
		});
		await search(
			planFor("seed stage fintech"),
			{ query: "seed stage fintech" },
			exaEnv(),
			new CostLedger(),
		);

		expect(started[0]?.minItems).toBe(1);
		expect(started[0]?.query).toContain(
			`${remaining * config.companies.judgeCandidateMultiple} distinct companies`,
		);
	});

	it("never asks the agent for more companies than fit in one round, at the largest request the API accepts", async () => {
		const { started } = stubAgentCompanyFetch();
		const remaining = config.limits.maxCompaniesPerRequest;

		const search = agentSearch({
			step: fakeWorkflowStep(),
			round: 1,
			remaining: remaining,
			today: "2026-08-30",
			seller: null,
		});
		await search(
			planFor("every mid-market SaaS company"),
			{ query: "every mid-market SaaS company" },
			exaEnv(),
			new CostLedger(),
		);

		expect(started[0]?.minItems).toBe(1);
		expect(started[0]?.query).toContain(
			`${config.companies.resultsPerRound} distinct companies`,
		);
		expect(started[0]?.query).not.toContain(
			`${remaining * config.companies.judgeCandidateMultiple} distinct`,
		);
	});

	it("tells the agent the headcount band the filter would otherwise reject on", async () => {
		const { started } = stubAgentCompanyFetch();

		const search = agentSearch({
			step: fakeWorkflowStep(),
			round: 1,
			remaining: 1,
			today: "2026-08-30",
			seller: null,
		});
		await search(
			planFor("B2B software with an outbound team", {
				minWorkforce: 10,
				maxWorkforce: 300,
				countries: ["United States"],
			}),
			{ query: "B2B software with an outbound team" },
			exaEnv(),
			new CostLedger(),
		);

		expect(started[0]?.query).toContain("headcount between 10 and 300");
		expect(started[0]?.query).toContain("United States");
	});
});

describe("a round whose agent finds nothing counts as an empty round, not a failure", () => {
	it("resolves to zero results and banks the run's cost, instead of throwing", async () => {
		stubAgentCompanyFetchReportingNull();
		const ledger = new CostLedger();

		const search = agentSearch({
			step: fakeWorkflowStep(),
			round: 1,
			remaining: 3,
			today: "2026-08-30",
			seller: null,
		});
		const result = await search(
			planFor("payment platforms serving credit unions"),
			{ query: "payment platforms serving credit unions" },
			exaEnv(),
			ledger,
		);

		expect(result.results).toEqual([]);
		expect(ledger.total()).toBeCloseTo(0.012, 5);
	});
});

describe("the round tells the agent which seller it prospects for", () => {
	it("carries the profile's seller into the started run", async () => {
		const { started } = stubAgentCompanyFetch();

		const search = agentSearch({
			step: fakeWorkflowStep(),
			round: 1,
			remaining: 1,
			today: "2026-08-30",
			seller: {
				domain: "form3.tech",
				customers: ["Klarna"],
				competitorTest: "A competitor sells payment infrastructure to banks.",
			},
		});
		await search(
			planFor("large European platform teams"),
			{ query: "large European platform teams" },
			exaEnv(),
			new CostLedger(),
		);

		expect(started[0]?.systemPrompt).toContain("form3.tech");
		expect(started[0]?.systemPrompt).toContain("Klarna");
	});
});
