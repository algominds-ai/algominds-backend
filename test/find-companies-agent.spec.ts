import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { buildAgentRunRequest } from "../src/core/companies/agent-search";
import { CostLedger } from "../src/core/cost";
import { buildVerdictRunRequest } from "../src/core/providers/exa/agent";
import type { SearchPlan } from "../src/core/synthesize";
import { AGENT_EFFORTS } from "../src/core/synthesize";
import { agentFanout } from "../src/workflows/find-companies-agent";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function planFor(query: string, band?: Partial<SearchPlan>): SearchPlan {
	return {
		query,
		angle: "angle-1",
		pageQuery: null,
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
		source: "exa-search",
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

function exaEnv(): Env {
	return { ...testEnv, EXA_API_KEY: { get: async () => "test-exa-key" } };
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

type StartedRun = {
	query: string;
	systemPrompt: string;
	minItems: number;
	maxItems: number;
};

function stubAgentCompanyFetch(): { started: StartedRun[] } {
	const started: StartedRun[] = [];
	globalThis.fetch = async (input, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			started.push({
				query: String(body.query),
				systemPrompt: String(body.systemPrompt),
				minItems: Number(body.outputSchema?.properties?.companies?.minItems),
				maxItems: Number(body.outputSchema?.properties?.companies?.maxItems),
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

function fanoutFor(
	step: WorkflowStep,
	seller: Parameters<typeof agentFanout>[0]["seller"] = null,
) {
	return agentFanout({ step, round: 1, today: "2026-08-30", seller });
}

describe("one agent round fans out across the angles the planner wrote", () => {
	it("starts one run per angle and merges what every angle found", async () => {
		const { started } = stubAgentCompanyFetch();
		const fanout = fanoutFor(fakeWorkflowStep());

		await fanout(
			[
				planFor("US managed service providers"),
				planFor("EU payment platforms"),
			],
			[],
			exaEnv(),
			new CostLedger(),
		);

		expect(started).toHaveLength(2);
		expect(started[0]?.query).toContain("US managed service providers");
		expect(started[1]?.query).toContain("EU payment platforms");
	});

	it("asks each angle for the configured companies per angle, never the whole count", async () => {
		const { started } = stubAgentCompanyFetch();
		const fanout = fanoutFor(fakeWorkflowStep());

		await fanout(
			[planFor("seed stage fintech")],
			[],
			exaEnv(),
			new CostLedger(),
		);

		const perAngle = config.companies.companiesPerAngle;
		expect(started[0]?.query).toContain(`Return up to ${perAngle} distinct`);
		expect(started[0]?.query).not.toContain("exactly");
		expect(started[0]?.minItems).toBe(1);
		expect(started[0]?.maxItems).toBe(perAngle);
	});

	it("waits between angle starts, so a fan-out never crosses the vendor's per-second limit", async () => {
		stubAgentCompanyFetch();
		const slept: string[] = [];
		const base = fakeWorkflowStep();
		const staggering: WorkflowStep = {
			do: base.do,
			sleepUntil: base.sleepUntil,
			waitForEvent: base.waitForEvent,
			sleep: async (name) => {
				slept.push(String(name));
			},
		};
		const fanout = fanoutFor(staggering);

		await fanout(
			[planFor("angle one"), planFor("angle two"), planFor("angle three")],
			[],
			exaEnv(),
			new CostLedger(),
		);

		expect(slept).toEqual([
			"round_1-angle_1-stagger",
			"round_1-angle_2-stagger",
		]);
	});

	it("names the account's excluded companies in every angle's request", async () => {
		const { started } = stubAgentCompanyFetch();
		const fanout = fanoutFor(fakeWorkflowStep());

		await fanout(
			[planFor("angle one"), planFor("angle two")],
			["seen.com", "known.io"],
			exaEnv(),
			new CostLedger(),
		);

		for (const run of started) {
			expect(run.query).toContain("seen.com");
			expect(run.query).toContain("known.io");
		}
	});

	it("tells the agent the headcount band the filter would otherwise reject on", async () => {
		const { started } = stubAgentCompanyFetch();
		const fanout = fanoutFor(fakeWorkflowStep());

		await fanout(
			[
				planFor("B2B software with an outbound team", {
					minWorkforce: 10,
					maxWorkforce: 300,
					countries: ["United States"],
				}),
			],
			[],
			exaEnv(),
			new CostLedger(),
		);

		expect(started[0]?.query).toContain("headcount between 10 and 300");
		expect(started[0]?.query).toContain("United States");
	});
});

describe("the poll interval scales with the angles in flight", () => {
	function stubAgentCompanyPolling(completeAfterPolls: number): void {
		const pollCounts = new Map<string, number>();
		let nextId = 0;
		globalThis.fetch = async (input, init) => {
			if (init?.method === "POST") {
				const id = `run-${nextId}`;
				nextId += 1;
				pollCounts.set(id, 0);
				return jsonResponse({ id, status: "running" });
			}
			const id = String(input).split("/").pop() ?? "";
			const count = (pollCounts.get(id) ?? 0) + 1;
			pollCounts.set(id, count);
			if (count < completeAfterPolls) {
				return jsonResponse({ id, status: "running" });
			}
			return jsonResponse({
				id,
				object: "agent_run",
				status: "completed",
				stopReason: "schema_satisfied",
				output: { text: "done", structured: { companies: [] } },
				costDollars: { total: 0.01, agentCompute: 0.01 },
			});
		};
	}

	function sleepCapturingStep(): {
		step: WorkflowStep;
		waits: { name: string; duration: string }[];
	} {
		const base = fakeWorkflowStep();
		const waits: { name: string; duration: string }[] = [];
		const step: WorkflowStep = {
			do: base.do,
			sleepUntil: base.sleepUntil,
			waitForEvent: base.waitForEvent,
			sleep: async (name, duration) => {
				waits.push({ name: String(name), duration: String(duration) });
			},
		};
		return { step, waits };
	}

	it("polls a twelve-angle fan-out every 30 seconds instead of the base 5", async () => {
		stubAgentCompanyPolling(2);
		const { step, waits } = sleepCapturingStep();
		const fanout = fanoutFor(step);
		const plans = Array.from({ length: 12 }, (_, index) =>
			planFor(`angle ${index}`),
		);

		await fanout(plans, [], exaEnv(), new CostLedger());

		const pollWaits = waits.filter((wait) => wait.name.includes("-wait-"));
		expect(pollWaits.length).toBeGreaterThan(0);
		for (const wait of pollWaits) {
			expect(wait.duration).toBe("30 seconds");
		}
	});

	it("keeps a single-angle round at the base 5 seconds", async () => {
		stubAgentCompanyPolling(2);
		const { step, waits } = sleepCapturingStep();
		const fanout = fanoutFor(step);

		await fanout([planFor("angle one")], [], exaEnv(), new CostLedger());

		const pollWaits = waits.filter((wait) => wait.name.includes("-wait-"));
		expect(pollWaits.length).toBeGreaterThan(0);
		for (const wait of pollWaits) {
			expect(wait.duration).toBe("5 seconds");
		}
	});
});

describe("a round whose agent finds nothing counts as an empty round, not a failure", () => {
	it("resolves to zero results and banks the run's cost, instead of throwing", async () => {
		stubAgentCompanyFetchReportingNull();
		const ledger = new CostLedger();
		const fanout = fanoutFor(fakeWorkflowStep());

		const result = await fanout(
			[planFor("payment platforms serving credit unions")],
			[],
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
		const fanout = fanoutFor(fakeWorkflowStep(), {
			domain: "form3.tech",
			customers: ["Klarna"],
			competitorTest: "A competitor sells payment infrastructure to banks.",
		});

		await fanout(
			[planFor("large European platform teams")],
			[],
			exaEnv(),
			new CostLedger(),
		);

		expect(started[0]?.systemPrompt).toContain("form3.tech");
		expect(started[0]?.systemPrompt).toContain("Klarna");
	});
});

describe("the request schema Exa's agent actually accepts", () => {
	it("sends Exa an output schema with no $schema key and no pattern anywhere", () => {
		const companyRequest = buildAgentRunRequest({
			plan: planFor("US managed service providers", {
				recency: "a role posted in the last 30 days",
				recencyDays: 30,
			}),
			count: 15,
			today: "2026-09-02",
			seller: null,
			excludeDomains: [],
		});
		const companySchema = JSON.parse(
			JSON.stringify(companyRequest.outputSchema),
		);
		expect(companySchema).not.toHaveProperty("$schema");
		expect(JSON.stringify(companySchema)).not.toContain('"pattern"');
		expect(companySchema.properties.companies.maxItems).toBe(15);

		const verdictRequest = buildVerdictRunRequest({
			name: "Jane Doe",
			title: "VP of Sales",
			company: "Acme",
			domain: "acme.com",
		});
		const verdictSchema = JSON.parse(
			JSON.stringify(verdictRequest.outputSchema),
		);
		expect(verdictSchema).not.toHaveProperty("$schema");
		expect(JSON.stringify(verdictSchema)).not.toContain('"pattern"');
	});
});

describe("the built request never asks the agent for effort above medium", () => {
	it("carries only low or medium, the two values a plan can hold", () => {
		expect(AGENT_EFFORTS).toEqual(["low", "medium"]);

		for (const agentEffort of AGENT_EFFORTS) {
			const request = buildAgentRunRequest({
				plan: planFor("US managed service providers", { agentEffort }),
				count: 5,
				today: "2026-09-02",
				seller: null,
				excludeDomains: [],
			});
			expect(request.effort).toBe(agentEffort);
		}
	});
});
