import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { FindPeopleDeps, FindPeopleOptions } from "../src/core/people";
import { findPeople } from "../src/core/people";
import type { PeopleCompany } from "../src/core/people/candidates";
import { agentPersonSearch } from "../src/workflows/find-people-agent";

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

type AgentPersonFixture = {
	name: string;
	linkedinUrl: string;
	title?: string;
};

/**
 * Stubs `fetch` for the Exa agent endpoint, routing each start request to
 * the fixture whose `match` text appears in that request's query, and
 * serving the matching completed run back for the poll that follows.
 */
function stubAgentPeopleFetch(
	fixtures: ReadonlyArray<{ match: string; people: AgentPersonFixture[] }>,
): { postCalls: number } {
	const state = { postCalls: 0 };
	const runsById = new Map<string, AgentPersonFixture[]>();
	globalThis.fetch = async (input, init) => {
		if (init?.method === "POST") {
			state.postCalls += 1;
			const body = JSON.parse(String(init.body));
			const fixture = fixtures.find((entry) =>
				String(body.query).includes(entry.match),
			);
			if (!fixture) throw new Error(`no fixture for query: ${body.query}`);
			const id = `run-${state.postCalls}`;
			runsById.set(id, fixture.people);
			return jsonResponse(200, { id, status: "running" });
		}
		const id = String(input).split("/").pop();
		const people = id ? runsById.get(id) : undefined;
		if (!people) throw new Error(`no run for url ${String(input)}`);
		return jsonResponse(200, {
			id,
			object: "agent_run",
			status: "completed",
			stopReason: "schema_satisfied",
			output: { text: "done", structured: { people } },
			costDollars: { total: 0.01, agentCompute: 0.01 },
		});
	};
	return state;
}

/**
 * A `WorkflowStep` whose `do` and `sleep` cache their result by name, the
 * same way Cloudflare's real Workflow engine does: calling `do` twice with
 * the same name returns the first call's result without running the
 * callback again. This is what would silently leak one company's people
 * onto another's if two companies in a batch ever shared a step name.
 */
function fakeWorkflowStep(): { step: WorkflowStep; names: string[] } {
	const names: string[] = [];
	const cache = new Map<string, Promise<unknown>>();
	async function runNamed(
		name: string,
		second: unknown,
		third: unknown,
	): Promise<unknown> {
		names.push(name);
		const cached = cache.get(name);
		if (cached) return cached;
		const callback = typeof second === "function" ? second : third;
		if (typeof callback !== "function") {
			throw new Error(`fake step: no callback for ${name}`);
		}
		const ctx: WorkflowStepContext = {
			step: { name, count: 0 },
			attempt: 1,
			config: {},
		};
		const result = callback(ctx);
		cache.set(name, result);
		return result;
	}
	const step: WorkflowStep = {
		do: runNamed,
		sleep: async (name: string) => {
			names.push(name);
		},
		sleepUntil: async (name: string) => {
			names.push(name);
		},
		waitForEvent: async () => {
			throw new Error("fake step: waitForEvent not implemented");
		},
	};
	return { step, names };
}

function testDeps(search: FindPeopleDeps["search"]): FindPeopleDeps {
	return {
		search,
		apolloSearch: async () => null,
	};
}

const companyA: PeopleCompany = {
	id: "company-a",
	domain: "acme.example",
	name: "Acme Corp",
	exaId: null,
};

const companyB: PeopleCompany = {
	id: "company-b",
	domain: "widget.example",
	name: "Widget Co",
	exaId: null,
};

describe("agentPersonSearch: two companies in one batch", () => {
	it("gives each company its own distinct people, never the other's", async () => {
		const fetchState = stubAgentPeopleFetch([
			{
				match: "at Acme Corp",
				people: [
					{
						name: "Alice Acme",
						linkedinUrl: "https://linkedin.com/in/alice-acme",
						title: "VP of Sales",
					},
				],
			},
			{
				match: "at Widget Co",
				people: [
					{
						name: "Bob Widget",
						linkedinUrl: "https://linkedin.com/in/bob-widget",
						title: "VP of Sales",
					},
				],
			},
		]);

		const { step, names } = fakeWorkflowStep();
		const search = agentPersonSearch(step, 0, [companyA, companyB]);
		const opts: FindPeopleOptions = {
			icp: { description: "seed stage fintech companies" },
			env: exaEnv(),
			plan: {
				titles: ["VP of Sales"],
				queryTemplate: "decision makers at {company}",
				userLocation: null,
			},
		};

		const result = await findPeople(
			[companyA, companyB],
			opts,
			testDeps(search),
		);

		const acme = result.companies.find((c) => c.domain === "acme.example");
		const widget = result.companies.find((c) => c.domain === "widget.example");
		expect(acme?.people.map((p) => p.fullName)).toEqual(["Alice Acme"]);
		expect(widget?.people.map((p) => p.fullName)).toEqual(["Bob Widget"]);
		expect(fetchState.postCalls).toBe(2);

		const startNames = names.filter((n) => n.endsWith("-agent-start"));
		expect(startNames).toHaveLength(2);
		expect(new Set(startNames).size).toBe(2);
		expect(startNames.sort()).toEqual([
			"people-batch-0-acme.example-agent-start",
			"people-batch-0-widget.example-agent-start",
		]);
	});

	it("names steps deterministically across a batch index and company position", async () => {
		const companyA: PeopleCompany = {
			id: "company-a",
			domain: "a.example",
			name: "Company A",
			exaId: null,
		};
		const companyB: PeopleCompany = {
			id: "company-b",
			domain: "b.example",
			name: "Company B",
			exaId: null,
		};
		stubAgentPeopleFetch([
			{
				match: "at Company A",
				people: [
					{ name: "Person A", linkedinUrl: "https://linkedin.com/in/a" },
				],
			},
			{
				match: "at Company B",
				people: [
					{ name: "Person B", linkedinUrl: "https://linkedin.com/in/b" },
				],
			},
		]);
		const { step, names } = fakeWorkflowStep();
		const search = agentPersonSearch(step, 3, [companyA, companyB]);
		const opts: FindPeopleOptions = {
			icp: { description: "seed stage fintech companies" },
			env: exaEnv(),
			plan: {
				titles: ["VP of Sales"],
				queryTemplate: "decision makers at {company}",
				userLocation: null,
			},
		};

		await findPeople([companyA, companyB], opts, testDeps(search));

		expect(names).toContain("people-batch-3-a.example-agent-start");
		expect(names).toContain("people-batch-3-a.example-agent-poll-1");
		expect(names).toContain("people-batch-3-b.example-agent-start");
		expect(names).toContain("people-batch-3-b.example-agent-poll-1");
	});
});

function _titlesGatewayEnv(): Env {
	return {
		...testEnv,
		AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
		CF_AIG_TOKEN: { get: async () => "test-aig-token" },
		MODEL_ROUTE_WORKER: "dynamic/brain-worker",
	};
}

function _titlesChatResponse(titles: string[]): Response {
	const payload = {
		id: "chatcmpl-test",
		model: "deepseek/deepseek-v4-flash-0731",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: JSON.stringify({
						titles,
						queryTemplate: "decision makers at {company}",
						userLocation: null,
					}),
				},
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
	};
	return jsonResponse(200, payload);
}
