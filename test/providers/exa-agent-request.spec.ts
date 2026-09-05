import { describe, expect, it } from "vitest";
import { buildAgentRunRequest } from "../../src/core/companies/agent-search";
import { startAgentRun } from "../../src/core/providers/exa/agent";
import type { SearchPlan } from "../../src/core/synthesize";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, respondOnce } from "../support/fetch";

function planFor(
	query: string,
	overrides: Partial<SearchPlan> = {},
): SearchPlan {
	return {
		query,
		angle: "angle-1",
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
		...overrides,
	};
}

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

function companyItems(plan: SearchPlan, count = 5) {
	const req = buildAgentRunRequest({
		plan,
		count,
		today: "2026-08-30",
		seller: null,
		excludeDomains: [],
	});
	return JSON.parse(JSON.stringify(req.outputSchema)).properties.companies
		.items;
}

describe("agent run start request shape", () => {
	it("posts the query, the effort, the fiber data source, and an outputSchema asking for the requested count", async () => {
		const captured = respondOnce(
			jsonResponse({ id: "run-1", status: "running" }),
		);
		globalThis.fetch = captured.fetch;
		const req = buildAgentRunRequest({
			plan: planFor("seed stage fintech"),
			count: 10,
			today: "2026-08-30",
			seller: null,
			excludeDomains: [],
		});

		await startAgentRun(req, exaEnv());

		const headers = new Headers(captured.calls[0]?.init?.headers);
		expect(headers.get("x-api-key")).toBe("test-exa-key");
		const body = JSON.parse(String(captured.calls[0]?.init?.body));
		expect(body.query).toContain("10");
		expect(body.effort).toBe("low");
		expect(body.dataSources).toEqual([{ provider: "fiber" }]);
		expect(body.outputSchema.properties.companies.minItems).toBe(1);
	});

	it("returns the started run's id", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({ id: "run-42", status: "running" }),
		).fetch;

		const result = await startAgentRun(
			buildAgentRunRequest({
				plan: planFor("seed stage fintech"),
				count: 5,
				today: "2026-08-30",
				seller: null,
				excludeDomains: [],
			}),
			exaEnv(),
		);

		expect(result.id).toBe("run-42");
	});
});

describe("the query mentions the recency window exactly when the plan sets one", () => {
	it("carries the window into the query, and says nothing when the profile asks for nothing recent", () => {
		const withWindow = buildAgentRunRequest({
			plan: planFor("seed stage fintech", {
				recency: "a funding round announced lately",
				recencyDays: 45,
			}),
			count: 10,
			today: "2026-09-01",
			seller: null,
			excludeDomains: [],
		});
		const without = buildAgentRunRequest({
			plan: planFor("seed stage fintech"),
			count: 10,
			today: "2026-09-01",
			seller: null,
			excludeDomains: [],
		});

		expect(withWindow.query).toContain("published in the last 45 days");
		expect(without.query).not.toContain("published in the last");
	});
});

describe("a signal is only demanded when the profile asks for something recent", () => {
	it("requires signal and evidenceUrl inside a window, and neither outside one", () => {
		const withWindow = companyItems(
			planFor("payment platforms", {
				recency: "A role posted in the last 30 days.",
			}),
		);
		const without = companyItems(planFor("payment platforms"));

		expect(withWindow.required).toContain("signal");
		expect(withWindow.required).toContain("evidenceUrl");
		expect(withWindow.required).not.toContain("evidenceDate");
		expect(without.required).not.toContain("signal");
		expect(without.required).not.toContain("evidenceUrl");
		expect(without.required).toContain("name");
		expect(without.required).toContain("website");
	});

	it("requires a verbatim quote and a named publisher only inside a recency window", () => {
		const withWindow = companyItems(
			planFor("payment platforms", {
				recency: "A role posted in the last 30 days.",
			}),
		);
		const without = companyItems(planFor("payment platforms"));

		expect(withWindow.required).toContain("evidenceQuote");
		expect(withWindow.required).toContain("evidencePublisher");
		expect(without.required).not.toContain("evidenceQuote");
		expect(without.required).not.toContain("evidencePublisher");
	});

	it("requires the evidence kind only inside a recency window", () => {
		const withWindow = companyItems(
			planFor("payment platforms", {
				recency: "A role posted in the last 30 days.",
			}),
		);
		const without = companyItems(planFor("payment platforms"));

		expect(withWindow.required).toContain("evidenceKind");
		expect(withWindow.properties.evidenceKind.enum).toContain(
			"vendor-case-study",
		);
		expect(without.required).not.toContain("evidenceKind");
	});
});

describe("Exa's agent rejects a schema that carries a pattern", () => {
	it("sends no pattern for website, evidenceUrl or linkedinUrl, yet still requires linkedinUrl", () => {
		const items = companyItems(planFor("payment platforms"));

		expect(items.properties.website.pattern).toBeUndefined();
		expect(items.properties.evidenceUrl.pattern).toBeUndefined();
		expect(items.properties.linkedinUrl.pattern).toBeUndefined();
		expect(items.required).toContain("linkedinUrl");
		expect(items.required).toContain("website");
	});
});

describe("a thin round comes back thin, never empty", () => {
	it("never sets a floor the agent can fail, because minItems stays 1 regardless of the requested count", () => {
		const req = buildAgentRunRequest({
			plan: planFor("payment platforms"),
			count: 30,
			today: "2026-08-30",
			seller: null,
			excludeDomains: [],
		});
		const schema = JSON.parse(JSON.stringify(req.outputSchema));

		expect(schema.properties.companies.minItems).toBe(1);
		expect(req.query).toContain("30 distinct companies");
	});
});

describe("the prompt tells the agent what day it is and what proves an event", () => {
	it("carries today's date, in a form the window sentence can be checked against", () => {
		const req = buildAgentRunRequest({
			plan: planFor("payment platforms"),
			count: 5,
			today: "2026-08-30",
			seller: null,
			excludeDomains: [],
		});

		expect(req.systemPrompt).toContain("2026-08-30");
		expect(req.systemPrompt).toContain("YYYY-MM-DD");
	});

	it("tells the agent to copy the evidence sentence verbatim and never guess a publisher", () => {
		const req = buildAgentRunRequest({
			plan: planFor("payment platforms"),
			count: 5,
			today: "2026-08-30",
			seller: null,
			excludeDomains: [],
		});

		expect(req.systemPrompt).toContain("copied word for word");
		expect(req.systemPrompt).toContain("the page does not say");
	});

	it("asks the agent for the industry the company sells into", () => {
		const req = buildAgentRunRequest({
			plan: planFor("staffing agencies"),
			count: 5,
			today: "2026-08-30",
			seller: null,
			excludeDomains: [],
		});

		expect(req.systemPrompt).toContain("`industry`");
	});

	it("bars a LinkedIn member profile as evidence, admitting only a post", () => {
		const req = buildAgentRunRequest({
			plan: planFor("payment platforms"),
			count: 5,
			today: "2026-08-30",
			seller: null,
			excludeDomains: [],
		});

		expect(req.systemPrompt).toContain("LinkedIn post");
		expect(req.systemPrompt).toContain("linkedin.com/in");
		expect(req.systemPrompt).toContain("never evidence");
	});
});

describe("the agent is told who it prospects for", () => {
	const seller = {
		domain: "form3.tech",
		customers: ["Klarna", "N26"],
		competitorTest:
			"A competitor sells payment infrastructure to banks and fintechs.",
	};

	function promptFor(sellerBlock: typeof seller | null): string | undefined {
		return buildAgentRunRequest({
			plan: planFor("payment platforms"),
			count: 5,
			today: "2026-08-30",
			seller: sellerBlock,
			excludeDomains: [],
		}).systemPrompt;
	}

	it("names the seller, its customers and the competitor test only when a seller is given", () => {
		const withSeller = promptFor(seller);
		const withoutSeller = promptFor(null);
		const noCustomers = promptFor({ ...seller, customers: [] });

		expect(withSeller).toContain("form3.tech");
		expect(withSeller).toContain("Klarna");
		expect(withSeller).toContain(seller.competitorTest);
		expect(withoutSeller).not.toContain("form3.tech");
		expect(withoutSeller).not.toContain("prospecting for");
		expect(noCustomers).not.toContain("already buy from it");
		expect(noCustomers).toContain(seller.competitorTest);
	});
});
