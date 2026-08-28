import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "../src/core/cost";
import { search } from "../src/core/providers/exa";
import { getAgentRun, startAgentRun } from "../src/core/providers/exa-agent";
import agentRun from "./fixtures/exa-agent-run-completed.json";
import agentPerson from "./fixtures/exa-agent-run-person.json";
import searchCompany from "./fixtures/exa-search-company.json";
import searchPeople from "./fixtures/exa-search-people.json";

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

	it("reads the same organization id off the result that the entity itself carries", async () => {
		respondWith(searchCompany);

		const result = await search(
			{ query: "small US software teams", category: "company" },
			env,
			new CostLedger(),
		);

		expect(result.results[0]?.id).toBe(
			"https://exa.ai/library/organization/16s078mffwh",
		);
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

describe("the parser against a real /search people response", () => {
	it("reads the person's current employer and its Exa organization id off workHistory", async () => {
		respondWith(searchPeople);

		const result = await search(
			{ query: "founder or CEO at Graphlit", category: "people" },
			env,
			new CostLedger(),
		);

		const person = result.results
			.map((row) => row.person)
			.find((candidate) => candidate?.fullName === "Kirk Marple");
		expect(person).toBeDefined();

		const current = person?.workHistory.filter((role) => role.current) ?? [];
		expect(current).toEqual([
			{
				title: "Chief Executive Officer, Technical Founder",
				from: "2021-02-01",
				current: true,
				companyId: "https://exa.ai/library/organization/lrjlz4ht43v",
				companyName: "Graphlit, by Unstruk Data",
			},
		]);
	});

	it("marks a role that has ended as not current", async () => {
		respondWith(searchPeople);

		const result = await search(
			{ query: "founder or CEO at Graphlit", category: "people" },
			env,
			new CostLedger(),
		);

		const person = result.results
			.map((row) => row.person)
			.find((candidate) => candidate?.fullName === "Kirk Marple");
		const ended = person?.workHistory.filter((role) => !role.current) ?? [];

		expect(ended.length).toBeGreaterThan(0);
		expect(ended.every((role) => role.current === false)).toBe(true);
	});

	it("never populates the company entity from a person-category result", async () => {
		respondWith(searchPeople);

		const result = await search(
			{ query: "founder or CEO at Graphlit", category: "people" },
			env,
			new CostLedger(),
		);

		expect(result.results[0]?.company).toBeNull();
	});
});

describe("the parser tolerates data the measured shape does not guarantee", () => {
	it("reads a work history entry whose employer has no Exa organization id", async () => {
		respondWith(searchPeople);

		const result = await search(
			{ query: "founder or CEO at Graphlit", category: "people" },
			env,
			new CostLedger(),
		);

		const person = result.results
			.map((row) => row.person)
			.find((candidate) => candidate?.fullName === "Abaho Katabarwa");
		const founderRole = person?.workHistory.find(
			(role) => role.companyName === "LLMGraph",
		);

		expect(founderRole?.companyId).toBeNull();
		expect(founderRole?.current).toBe(true);
	});

	it("drops one entity of an unmodelled type rather than failing the whole result", async () => {
		respondWith({
			requestId: "with-unknown-entity",
			results: [
				{
					id: "https://exa.ai/library/person/2wr56lj8gbj",
					title: "Kirk Marple",
					url: "https://www.linkedin.com/in/kirkmarple",
					entities: [
						{
							id: "https://exa.ai/library/person/2wr56lj8gbj",
							type: "person",
							properties: {
								name: "Kirk Marple",
								workHistory: [
									{
										title: "Chief Executive Officer, Technical Founder",
										dates: { from: "2021-02-01", to: null },
										company: {
											id: "https://exa.ai/library/organization/lrjlz4ht43v",
											name: "Graphlit, by Unstruk Data",
										},
									},
								],
							},
						},
						{
							id: "https://exa.ai/library/publication/unknown",
							type: "publication",
							properties: { headline: "not a company or a person" },
						},
					],
				},
			],
			costDollars: { total: 0.007 },
		});

		const result = await search(
			{ query: "founder or CEO at Graphlit", category: "people" },
			env,
			new CostLedger(),
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.person?.fullName).toBe("Kirk Marple");
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
		if (run.status !== "completed") throw new Error("expected a completed run");
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
