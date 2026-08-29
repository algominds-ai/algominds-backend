import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAgentRunRequest,
	toExaSearchResult,
} from "../src/core/companies/agent-search";
import { CostLedger } from "../src/core/cost";
import {
	getAgentPeopleRun,
	getAgentRun,
	startAgentRun,
} from "../src/core/providers/exa/agent";
import { RetryableProviderError } from "../src/core/providers/waterfall";
import type { SearchPlan } from "../src/core/synthesize";
import runningRun from "./fixtures/exa-agent-run-running.json";

type FetchStub = { calls: number; init: RequestInit | undefined };

function planFor(query: string): SearchPlan {
	return {
		query,
		angle: "angle-1",
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
	};
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function exaEnv(): Env {
	return { ...testEnv, EXA_API_KEY: { get: async () => "test-exa-key" } };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch(response: Response): FetchStub {
	const stub: FetchStub = { calls: 0, init: undefined };
	globalThis.fetch = async (_input, init) => {
		stub.calls += 1;
		stub.init = init;
		return response;
	};
	return stub;
}

type AgentCompanyFixture = { name?: string; website?: string };

type CompletedRunOverrides = {
	output?: { structured: { companies: AgentCompanyFixture[] } };
};

function completedRunBody(overrides: CompletedRunOverrides = {}) {
	return {
		id: "run-completed",
		status: "completed",
		output: {
			structured: {
				companies: [{ name: "Acme", website: "acme.com" }],
			},
		},
		costDollars: { total: 0.025, agentCompute: 0.018, search: 0.007 },
		...overrides,
	};
}

describe("agent run start request shape", () => {
	it("posts the query, the effort, the fiber data source, and an outputSchema asking for the requested count", async () => {
		const stub = stubFetch(
			jsonResponse(200, { id: "run-1", status: "running" }),
		);
		const req = buildAgentRunRequest(planFor("seed stage fintech"), 10, "low");

		await startAgentRun(req, exaEnv());

		const headers = new Headers(stub.init?.headers);
		expect(headers.get("x-api-key")).toBe("test-exa-key");
		const body = JSON.parse(String(stub.init?.body));
		expect(body.query).toContain("10");
		expect(body.effort).toBe("low");
		expect(body.dataSources).toEqual([{ provider: "fiber" }]);
		expect(body.outputSchema.properties.companies.minItems).toBe(10);
	});

	it("returns the started run's id", async () => {
		stubFetch(jsonResponse(200, { id: "run-42", status: "running" }));

		const result = await startAgentRun(
			buildAgentRunRequest(planFor("seed stage fintech"), 5, "low"),
			exaEnv(),
		);

		expect(result.id).toBe("run-42");
	});
});

describe("agent run error mapping", () => {
	it("raises RetryableProviderError on a 429", async () => {
		stubFetch(
			jsonResponse(429, { requestId: "req-429", message: "slow down" }),
		);

		await expect(
			startAgentRun(
				buildAgentRunRequest(planFor("GTM leads"), 5, "low"),
				exaEnv(),
			),
		).rejects.toThrow(RetryableProviderError);
	});

	it("raises NonRetryableError on a 400", async () => {
		stubFetch(
			jsonResponse(400, { requestId: "req-400", message: "bad request" }),
		);

		await expect(
			startAgentRun(
				buildAgentRunRequest(planFor("GTM leads"), 5, "low"),
				exaEnv(),
			),
		).rejects.toThrow(NonRetryableError);
	});

	it("raises RetryableProviderError when the request times out", async () => {
		globalThis.fetch = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};

		await expect(
			startAgentRun(
				buildAgentRunRequest(planFor("GTM leads"), 5, "low"),
				exaEnv(),
			),
		).rejects.toThrow(RetryableProviderError);
	});
});

describe("agent people run linkedin url shape check", () => {
	function peopleRunBody(linkedinUrl: string | null) {
		return {
			id: "run-people",
			status: "completed",
			output: {
				structured: {
					people: [{ name: "A Person", linkedinUrl }],
				},
			},
			costDollars: { total: 0.01 },
		};
	}

	it("nulls a linkedinUrl that is not a linkedin.com profile url", async () => {
		stubFetch(jsonResponse(200, peopleRunBody("https://example.com/fake")));

		const run = await getAgentPeopleRun(
			"run-people",
			exaEnv(),
			new CostLedger(),
		);

		expect(run.status).toBe("completed");
		if (run.status !== "completed") return;
		expect(run.people[0]?.linkedinUrl).toBeNull();
	});

	it("keeps a linkedinUrl that is a real linkedin.com profile url", async () => {
		stubFetch(
			jsonResponse(200, peopleRunBody("https://www.linkedin.com/in/a-person")),
		);

		const run = await getAgentPeopleRun(
			"run-people",
			exaEnv(),
			new CostLedger(),
		);

		expect(run.status).toBe("completed");
		if (run.status !== "completed") return;
		expect(run.people[0]?.linkedinUrl).toBe(
			"https://www.linkedin.com/in/a-person",
		);
	});
});

describe("agent run response shape", () => {
	it("raises NonRetryableError, not a half-parsed object, on a malformed completed body", async () => {
		stubFetch(
			jsonResponse(200, {
				status: "completed",
				output: { structured: { companies: "not-an-array" } },
				costDollars: { total: 0.01 },
			}),
		);

		let caught: unknown;
		try {
			await getAgentRun("run-bad", exaEnv(), new CostLedger());
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NonRetryableError);
		expect(caught).not.toBeInstanceOf(RetryableProviderError);
	});

	it("treats a run still running as running, not completed", async () => {
		stubFetch(jsonResponse(200, { id: "run-running", status: "running" }));

		const run = await getAgentRun("run-running", exaEnv(), new CostLedger());

		expect(run.status).toBe("running");
	});

	it("surfaces a failed run as an error rather than empty success", async () => {
		stubFetch(jsonResponse(200, { id: "run-failed", status: "failed" }));

		await expect(
			getAgentRun("run-failed", exaEnv(), new CostLedger()),
		).rejects.toThrow(NonRetryableError);
	});

	it("surfaces a canceled run as an error naming the status", async () => {
		stubFetch(jsonResponse(200, { id: "run-canceled", status: "canceled" }));

		await expect(
			getAgentRun("run-canceled", exaEnv(), new CostLedger()),
		).rejects.toThrow(/canceled/);
	});
});

describe("agent run cost reporting", () => {
	it("reports costDollars into the ledger once the run completes", async () => {
		stubFetch(jsonResponse(200, completedRunBody()));
		const ledger = new CostLedger();

		await getAgentRun("run-completed", exaEnv(), ledger);

		const byProvider = ledger.byProvider();
		expect(byProvider.agentCompute).toBe(0.018);
		expect(byProvider.search).toBe(0.007);
		expect(ledger.total()).toBeCloseTo(0.025, 5);
	});
});

describe("agent run to CompanyEntity mapping", () => {
	it("maps a completed run's companies onto the same shape `search` returns, nulling fields the agent gave nothing for", async () => {
		stubFetch(jsonResponse(200, completedRunBody()));

		const run = await getAgentRun("run-completed", exaEnv(), new CostLedger());
		expect(run.status).toBe("completed");
		if (run.status !== "completed") return;

		const result = toExaSearchResult("run-completed", run.companies);

		expect(result.requestId).toBe("run-completed");
		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.url).toBe("acme.com");
		expect(result.results[0]?.company).toEqual({
			name: "Acme",
			description: null,
			foundedYear: null,
			workforceTotal: null,
			city: null,
			country: null,
			revenueAnnual: null,
			fundingTotal: null,
		});
	});

	it("drops a company the agent gave no website for", async () => {
		stubFetch(
			jsonResponse(
				200,
				completedRunBody({
					output: { structured: { companies: [{ name: "No Website Co" }] } },
				}),
			),
		);

		const run = await getAgentRun("run-completed", exaEnv(), new CostLedger());
		if (run.status !== "completed") throw new Error("expected a completed run");

		const result = toExaSearchResult("run-completed", run.companies);

		expect(result.results).toHaveLength(0);
	});
});

describe("a run that is still working", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("reads a null structured payload as running, not as a bad shape", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify(runningRun), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		const run = await getAgentRun(runningRun.id, exaEnv(), new CostLedger());

		expect(run.status).toBe("running");
	});

	it("spends nothing from the ledger while it is still working", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify(runningRun), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const ledger = new CostLedger();

		await getAgentRun(runningRun.id, exaEnv(), ledger);

		expect(ledger.total()).toBe(0);
	});
});
