import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "../src/core/cost";
import { search } from "../src/core/providers/exa";
import { getAgentRun, startAgentRun } from "../src/core/providers/exa-agent";
import agentRun from "./fixtures/exa-agent-run-completed.json";
import agentPerson from "./fixtures/exa-agent-run-person.json";
import searchCompany from "./fixtures/exa-search-company.json";

const env: Env = {
	...testEnv,
	EXA_API_KEY: { get: async () => "test-exa-key" },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function respondWith(body: unknown): void {
	globalThis.fetch = async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
}

describe("the parser against a real /search company response", () => {
	it("reads the structured entity the pipeline depends on", async () => {
		respondWith(searchCompany);

		const result = await search(
			{ query: "small US software teams", category: "company" },
			env,
			new CostLedger(),
		);

		expect(result.results).toHaveLength(3);
		const first = result.results[0];
		expect(first?.company).not.toBeNull();
		expect(first?.company?.name).toBe("Veles");
		expect(first?.company?.workforceTotal).toBe(2);
	});

	it("reads the financial figures the vendor did supply", async () => {
		respondWith(searchCompany);

		const result = await search(
			{ query: "small US software teams", category: "company" },
			env,
			new CostLedger(),
		);

		const veles = result.results.find((r) => r.company?.name === "Veles");
		expect(veles?.company?.revenueAnnual).toBe(6700000);
		expect(veles?.company?.country).toBe("United States");
	});

	it("reads a company the vendor did fill in completely", async () => {
		respondWith(searchCompany);

		const result = await search(
			{ query: "small US software teams", category: "company" },
			env,
			new CostLedger(),
		);

		const aspiro = result.results.find((r) => r.company?.name === "Aspiro");
		expect(aspiro?.company?.foundedYear).toBe(2020);
		expect(aspiro?.company?.workforceTotal).toBe(5);
	});

	it("reports the vendor's own cost from the real response", async () => {
		respondWith(searchCompany);
		const ledger = new CostLedger();

		await search(
			{ query: "small US software teams", category: "company" },
			env,
			ledger,
		);

		expect(ledger.total()).toBeGreaterThan(0);
	});
});

describe("the parser against a real /agent/runs response", () => {
	it("accepts the id and status a real start returns", async () => {
		respondWith({ id: agentRun.id, status: "running" });

		const started = await startAgentRun(
			{
				query: "small US software teams",
				effort: "low",
				outputSchema: { type: "object" },
			},
			env,
		);

		expect(started.id).toBe(agentRun.id);
	});

	it("reads the structured output of a real completed run", async () => {
		respondWith(agentRun);

		const run = await getAgentRun(agentRun.id, env, new CostLedger());

		expect(run.status).toBe("completed");
		expect(run.companies.length).toBeGreaterThan(0);
	});

	it("reports the itemised cost a real run returns", async () => {
		respondWith(agentRun);
		const ledger = new CostLedger();

		await getAgentRun(agentRun.id, env, ledger);

		expect(ledger.total()).toBeGreaterThan(0);
	});

	it("carries a real person run's cited source through", () => {
		const people = agentPerson.output.structured.people;

		expect(people[0]?.email).toContain("@");
		expect(people[0]?.source).toContain("http");
	});
});
