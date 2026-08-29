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
		userLocation: null,
		countries: [],
		minWorkforce: null,
		maxWorkforce: null,
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

type StartedRun = { query: string; minItems: number };

function stubAgentCompanyFetch(): { started: StartedRun[] } {
	const started: StartedRun[] = [];
	globalThis.fetch = async (input, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			started.push({
				query: String(body.query),
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

		const search = agentSearch(fakeWorkflowStep(), 1, remaining);
		await search(
			planFor("small US software teams"),
			{ query: "small US software teams" },
			exaEnv(),
			new CostLedger(),
		);

		const wanted = remaining * config.companies.judgeCandidateMultiple;
		expect(started).toHaveLength(1);
		expect(started[0]?.minItems).toBe(wanted);
		expect(started[0]?.query).toContain(`${wanted} distinct companies`);
	});

	it("keeps the funnel wider than the ask for a larger request too", async () => {
		const { started } = stubAgentCompanyFetch();
		const remaining = 4;

		const search = agentSearch(fakeWorkflowStep(), 1, remaining);
		await search(
			planFor("seed stage fintech"),
			{ query: "seed stage fintech" },
			exaEnv(),
			new CostLedger(),
		);

		expect(started[0]?.minItems).toBeGreaterThan(remaining);
		expect(started[0]?.minItems).toBe(
			remaining * config.companies.judgeCandidateMultiple,
		);
	});

	it("tells the agent the headcount band the filter would otherwise reject on", async () => {
		const { started } = stubAgentCompanyFetch();

		const search = agentSearch(fakeWorkflowStep(), 1, 1);
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

		expect(started[0]?.query).toContain("between 10 and 300 employees");
		expect(started[0]?.query).toContain("United States");
	});
});
