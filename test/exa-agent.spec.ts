import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAgentRunRequest,
	toExaSearchResult,
} from "../src/core/companies/agent-search";
import { filterEntities } from "../src/core/companies/candidates";
import { CostLedger } from "../src/core/cost";
import {
	ExaAgentCompanySchema,
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
		recency: null,
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
		const req = buildAgentRunRequest(
			planFor("seed stage fintech"),
			10,
			"2026-08-30",
		);

		await startAgentRun(req, exaEnv());

		const headers = new Headers(stub.init?.headers);
		expect(headers.get("x-api-key")).toBe("test-exa-key");
		const body = JSON.parse(String(stub.init?.body));
		expect(body.query).toContain("10");
		expect(body.effort).toBe("low");
		expect(body.dataSources).toEqual([{ provider: "fiber" }]);
		expect(body.outputSchema.properties.companies.minItems).toBe(1);
	});

	it("returns the started run's id", async () => {
		stubFetch(jsonResponse(200, { id: "run-42", status: "running" }));

		const result = await startAgentRun(
			buildAgentRunRequest(planFor("seed stage fintech"), 5, "2026-08-30"),
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
				buildAgentRunRequest(planFor("GTM leads"), 5, "2026-08-30"),
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
				buildAgentRunRequest(planFor("GTM leads"), 5, "2026-08-30"),
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
				buildAgentRunRequest(planFor("GTM leads"), 5, "2026-08-30"),
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
			industry: null,
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

describe("the agent is asked for evidence, and for evidence inside a window", () => {
	function companySchema(count: number, plan: SearchPlan) {
		const req = buildAgentRunRequest(
			{ ...plan, recency: "A role posted in the last 30 days." },
			count,
			"2026-08-30",
		);
		const parsed = JSON.parse(JSON.stringify(req.outputSchema));
		return parsed.properties.companies.items;
	}

	it("demands the signal and the page that proves it, and leaves the date optional", () => {
		const items = companySchema(5, planFor("payment platforms"));

		expect(items.required).toContain("signal");
		expect(items.required).toContain("evidenceUrl");
		expect(items.required).toContain("name");
		expect(items.required).toContain("website");
		expect(items.required).not.toContain("evidenceDate");
		expect(items.properties.evidenceDate).toBeDefined();
	});

	it("keeps the directory-host pattern on the company site and off the evidence page", () => {
		const items = companySchema(5, planFor("payment platforms"));

		expect(items.properties.website.pattern).toContain("linkedin");
		expect(items.properties.evidenceUrl.pattern).toBeUndefined();
	});

	it("tells the agent today's date so a window in the query means something", () => {
		const req = buildAgentRunRequest(
			planFor("payment platforms"),
			5,
			"2026-08-30",
		);

		expect(req.systemPrompt).toContain("2026-08-30");
		expect(req.systemPrompt).toContain("YYYY-MM-DD");
	});

	it("carries the profile's freshness windows into the query, and nothing when it asks for none", () => {
		const withWindow = buildAgentRunRequest(
			{
				...planFor("payment platforms"),
				recency: "A role posted in the last 30 days.",
			},
			5,
			"2026-08-30",
		);
		const without = buildAgentRunRequest(
			planFor("payment platforms"),
			5,
			"2026-08-30",
		);

		expect(withWindow.query).toContain("last 30 days");
		expect(without.query).not.toContain("last 30 days");
	});
});

describe("an agent company becomes a row whose domain is the company, not the evidence host", () => {
	it("keeps the website as the result url and the proving page as the evidence url", () => {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Kastle",
				website: "https://kastle.com",
				linkedinUrl: null,
				description: null,
				industry: null,
				foundedYear: null,
				workforceTotal: null,
				city: null,
				country: null,
				revenueAnnual: null,
				fundingTotal: null,
				signal: "posted a Head of Sales role",
				evidenceUrl: "https://jobs.ashbyhq.com/kastle/735bed91",
				evidenceDate: "2026-08-12",
				evidenceQuote: null,
				evidencePublisher: null,
			},
		]);

		expect(results).toHaveLength(1);
		expect(results[0]?.url).toBe("https://kastle.com");
		expect(results[0]?.evidenceUrl).toBe(
			"https://jobs.ashbyhq.com/kastle/735bed91",
		);
		expect(results[0]?.publishedDate).toBe("2026-08-12");
		expect(results[0]?.signal).toBe("posted a Head of Sales role");
	});

	it("drops the agent's extra fields from the stored company record", () => {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Kastle",
				website: "https://kastle.com",
				linkedinUrl: null,
				description: null,
				industry: null,
				foundedYear: null,
				workforceTotal: 470,
				city: null,
				country: "United States",
				revenueAnnual: null,
				fundingTotal: null,
				signal: "posted a Head of Sales role",
				evidenceUrl: "https://jobs.ashbyhq.com/kastle/735bed91",
				evidenceDate: "2026-08-12",
				evidenceQuote: null,
				evidencePublisher: null,
			},
		]);

		expect(results[0]?.company).toEqual({
			name: "Kastle",
			description: null,
			industry: null,
			foundedYear: null,
			workforceTotal: 470,
			city: null,
			country: "United States",
			revenueAnnual: null,
			fundingTotal: null,
		});
	});
});

describe("the agent's evidence reaches the row the judge reads", () => {
	function rowFor(signal: string | null, evidenceUrl: string | null) {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Kastle",
				website: "https://kastle.com",
				linkedinUrl: null,
				description: "a security company",
				industry: null,
				foundedYear: null,
				workforceTotal: 470,
				city: null,
				country: "United States",
				revenueAnnual: null,
				fundingTotal: null,
				signal,
				evidenceUrl,
				evidenceDate: "2026-08-12",
				evidenceQuote: null,
				evidencePublisher: null,
			},
		]);
		return filterEntities(results, planFor("security companies"), "2026-08-30")
			.rows[0];
	}

	it("cites the proving page, keeps the company as the domain, and shows the judge the signal", () => {
		const row = rowFor(
			"posted a Head of Sales role on 2026-08-12",
			"https://jobs.ashbyhq.com/kastle/735bed91",
		);

		expect(row?.domain).toBe("kastle.com");
		expect(row?.evidenceUrl).toBe("https://jobs.ashbyhq.com/kastle/735bed91");
		expect(row?.evidenceDate).toBe("2026-08-12");
		expect(row?.signal).toBe("posted a Head of Sales role on 2026-08-12");
		expect(row?.description).toContain("headcount 470");
		expect(row?.description).not.toContain("posted a Head of Sales");
	});

	it("falls back to the company's own site when a source proves nothing", () => {
		const row = rowFor(null, null);

		expect(row?.evidenceUrl).toBe("https://kastle.com");
		expect(row?.signal).toBeNull();
		expect(row?.description).toContain("headcount 470");
	});
});

describe("what is stored keeps the evidence, not just the company", () => {
	it("captures the signal and the proving page for the row that gets saved", () => {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Kastle",
				website: "https://kastle.com",
				linkedinUrl: null,
				description: "a security company",
				industry: null,
				foundedYear: null,
				workforceTotal: 470,
				city: null,
				country: "United States",
				revenueAnnual: null,
				fundingTotal: null,
				signal: "posted a Head of Sales role",
				evidenceUrl: "https://jobs.ashbyhq.com/kastle/735bed91",
				evidenceDate: "2026-08-12",
				evidenceQuote: null,
				evidencePublisher: null,
			},
		]);
		const { captures } = filterEntities(
			results,
			planFor("security companies"),
			"2026-08-30",
		);
		const capture = captures["kastle.com"];

		expect(capture?.result.signal).toBe("posted a Head of Sales role");
		expect(capture?.result.url).toBe(
			"https://jobs.ashbyhq.com/kastle/735bed91",
		);
		expect(capture?.result.publishedDate).toBe("2026-08-12");
	});
});

describe("a signal is only demanded when the profile asks for something recent", () => {
	function itemsFor(plan: SearchPlan) {
		const req = buildAgentRunRequest(plan, 5, "2026-08-30");
		return JSON.parse(JSON.stringify(req.outputSchema)).properties.companies
			.items;
	}

	it("demands the signal and its page when the profile names a window", () => {
		const items = itemsFor({
			...planFor("payment platforms"),
			recency: "A role posted in the last 30 days.",
		});

		expect(items.required).toContain("signal");
		expect(items.required).toContain("evidenceUrl");
	});

	it("asks for no signal when the profile names no window, so none is invented", () => {
		const items = itemsFor(planFor("payment platforms"));

		expect(items.required).not.toContain("signal");
		expect(items.required).not.toContain("evidenceUrl");
		expect(items.required).toContain("name");
		expect(items.required).toContain("website");
	});

	it("requires a LinkedIn company page, never a personal profile", () => {
		const items = itemsFor(planFor("payment platforms"));

		expect(items.properties.linkedinUrl.pattern).toContain("company");
		expect(items.required).toContain("linkedinUrl");
		expect(items.required).toContain("website");
	});
});

describe("a company LinkedIn page reaches the row, a personal profile does not", () => {
	function rowFor(linkedinUrl: string | null) {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Kastle",
				website: "https://kastle.com",
				linkedinUrl: linkedinUrl || null,
				description: null,
				industry: null,
				foundedYear: null,
				workforceTotal: null,
				city: null,
				country: null,
				revenueAnnual: null,
				fundingTotal: null,
				signal: null,
				evidenceUrl: null,
				evidenceDate: null,
				evidenceQuote: null,
				evidencePublisher: null,
			},
		]);
		return filterEntities(results, planFor("security companies"), "2026-08-30")
			.rows[0];
	}

	it("keeps a linkedin.com/company address", () => {
		expect(rowFor("https://linkedin.com/company/kastle")?.linkedinUrl).toBe(
			"https://linkedin.com/company/kastle",
		);
	});

	it("drops a personal profile the agent mistook for the company", () => {
		const parsed = ExaAgentCompanySchema.parse({
			name: "Kastle",
			website: "https://kastle.com",
			linkedinUrl: "https://linkedin.com/in/some-person",
		});

		expect(parsed.linkedinUrl).toBeNull();
		expect(rowFor(parsed.linkedinUrl)?.linkedinUrl).toBeNull();
	});
});

describe("the agent hands over the page, not only its own summary of it", () => {
	function itemsFor(recency: string | null) {
		const req = buildAgentRunRequest(
			{ ...planFor("payment platforms"), recency },
			5,
			"2026-08-30",
		);
		return JSON.parse(JSON.stringify(req.outputSchema)).properties.companies
			.items;
	}

	it("demands a verbatim quote and a named publisher when a window is asked for", () => {
		const items = itemsFor("A role posted in the last 30 days.");

		expect(items.required).toContain("evidenceQuote");
		expect(items.required).toContain("evidencePublisher");
	});

	it("asks for neither when the profile wants nothing recent", () => {
		const items = itemsFor(null);

		expect(items.required).not.toContain("evidenceQuote");
		expect(items.required).not.toContain("evidencePublisher");
	});

	it("tells the agent to copy the sentence and never to guess a publisher", () => {
		const req = buildAgentRunRequest(
			planFor("payment platforms"),
			5,
			"2026-08-30",
		);

		expect(req.systemPrompt).toContain("copied word for word");
		expect(req.systemPrompt).toContain("the page does not say");
	});

	it("carries the quote and the publisher onto the row and the capture", () => {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Kastle",
				website: "https://kastle.com",
				linkedinUrl: null,
				description: null,
				industry: null,
				foundedYear: null,
				workforceTotal: null,
				city: null,
				country: null,
				revenueAnnual: null,
				fundingTotal: null,
				signal: "posted a Head of Sales role",
				evidenceUrl: "https://jobs.ashbyhq.com/kastle/735bed91",
				evidenceDate: "2026-08-12",
				evidenceQuote: "Kastle is hiring a Head of Sales in San Francisco.",
				evidencePublisher: "Kastle Careers",
			},
		]);
		const outcome = filterEntities(
			results,
			planFor("security companies"),
			"2026-08-30",
		);

		expect(outcome.rows[0]?.evidenceQuote).toBe(
			"Kastle is hiring a Head of Sales in San Francisco.",
		);
		expect(outcome.rows[0]?.evidencePublisher).toBe("Kastle Careers");
		expect(outcome.captures["kastle.com"]?.result.quote).toBe(
			"Kastle is hiring a Head of Sales in San Francisco.",
		);
		expect(outcome.captures["kastle.com"]?.result.publisher).toBe(
			"Kastle Careers",
		);
	});
});

describe("evidence outside the window the profile asks for is refused in code", () => {
	function outcomeFor(evidenceDate: string | null, recencyDays: number | null) {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Kadmos",
				website: "https://kadmos.io",
				linkedinUrl: null,
				description: null,
				industry: null,
				foundedYear: null,
				workforceTotal: null,
				city: null,
				country: null,
				revenueAnnual: null,
				fundingTotal: null,
				signal: "granted an electronic money institution licence",
				evidenceUrl: "https://kadmos.io/press-releases/emi",
				evidenceDate,
				evidenceQuote:
					"Kadmos granted FCA Electronic Money Institution authorisation",
				evidencePublisher: "Kadmos",
			},
		]);
		return filterEntities(
			results,
			{ ...planFor("payment providers"), recencyDays },
			"2026-08-30",
		);
	}

	it("refuses a page four days past the window, which the judge read as about a year", () => {
		const outcome = outcomeFor("2025-08-26", 365);

		expect(outcome.rows).toHaveLength(0);
		expect(outcome.rejects[0]?.reason).toContain("369 days old");
		expect(outcome.rejects[0]?.stage).toBe("filter");
	});

	it("keeps a page inside the window", () => {
		expect(outcomeFor("2026-08-19", 365).rows).toHaveLength(1);
	});

	it("sends an undated page to the judge, which knows whether that kind of page needs a date", () => {
		const outcome = outcomeFor(null, 90);

		expect(outcome.rows).toHaveLength(1);
		expect(outcome.rejects).toHaveLength(0);
	});

	it("keeps an undated page when the profile asks for nothing recent", () => {
		expect(outcomeFor(null, null).rows).toHaveLength(1);
	});
});

describe("a thin round comes back thin, never empty", () => {
	it("never sets a floor the agent can fail, because a failed schema discards everything it found", () => {
		const req = buildAgentRunRequest(
			planFor("payment platforms"),
			30,
			"2026-08-30",
		);
		const schema = JSON.parse(JSON.stringify(req.outputSchema));

		expect(schema.properties.companies.minItems).toBe(1);
		expect(req.query).toContain("30 distinct companies");
	});
});

describe("the industry the agent reports reaches the row and the stored company", () => {
	it("carries the industry through, and describes the company with it", () => {
		const { results } = toExaSearchResult("req-1", [
			{
				name: "Zealhire",
				website: "https://zealhire.com",
				linkedinUrl: "https://linkedin.com/company/zealhire",
				description: null,
				industry: "IT staffing and recruitment",
				foundedYear: null,
				workforceTotal: 40,
				city: null,
				country: "United States",
				revenueAnnual: null,
				fundingTotal: null,
				signal: "posted for a India based recruiter on US shift",
				evidenceUrl: "https://linkedin.com/posts/zealhire_hiring",
				evidenceDate: "2026-08-03",
				evidenceQuote: "Shift: Night Shift (US EST Timings)",
				evidencePublisher: "Zealhire",
			},
		]);
		const outcome = filterEntities(
			results,
			planFor("staffing agencies"),
			"2026-08-30",
		);

		expect(outcome.rows[0]?.industry).toBe("IT staffing and recruitment");
		expect(outcome.rows[0]?.description).toContain(
			"IT staffing and recruitment",
		);
		expect(outcome.captures["zealhire.com"]?.entity.industry).toBe(
			"IT staffing and recruitment",
		);
	});

	it("asks the agent for the market it sells into", () => {
		const req = buildAgentRunRequest(
			planFor("staffing agencies"),
			5,
			"2026-08-30",
		);

		expect(req.systemPrompt).toContain("`industry`");
	});
});
