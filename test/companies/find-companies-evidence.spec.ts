import { afterEach, describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { toExaSearchResult } from "@/core/companies/agent-search";
import { gate } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import type { ExaAgentCompany } from "@/core/providers/exa/agent";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import type { SearchPlan } from "@/core/synthesize";
import { fakeSecretEnv } from "../support/env";
import { exaContentsFetch } from "../support/fetch";

function goodResult(
	domain: string,
	overrides: Partial<CompanyEntity> = {},
): ExaResult {
	return {
		id: `https://exa.ai/library/organization/${domain}`,
		url: `https://${domain}/`,
		title: `Company ${domain}`,
		summary: null,
		company: {
			name: `Company ${domain}`,
			description: "a small software company",
			industry: null,
			foundedYear: 2021,
			workforceTotal: 8,
			city: "San Francisco",
			country: "United States",
			revenueAnnual: null,
			fundingTotal: null,
			...overrides,
		},
		person: null,
	};
}

function agentRow(domain: string, quote: string): ExaResult {
	return {
		...goodResult(domain),
		evidenceUrl: `https://${domain}/careers`,
		evidenceQuote: quote,
	};
}

function exaOptions(): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
		today: "2026-08-30",
		requirements: [
			{
				id: "r1",
				text: "the company fits the profile",
				kind: "hard",
				proof: "record",
				windowDays: null,
			},
		],
	};
}

function scriptedAgentRound(rounds: ExaResult[][]) {
	const calls: Array<readonly string[]> = [];
	const agentRound: FindCompaniesDeps["agentRound"] = async (
		_plans,
		excludeDomains,
		_env,
		ledger,
	) => {
		const results = rounds[calls.length] ?? [];
		calls.push(excludeDomains);
		ledger.reported("exa", "agent", 0.02);
		return { requestId: `agent-${calls.length}`, results };
	};
	return { agentRound, calls };
}

function testPlan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "companies",
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
		...overrides,
	};
}

function agentPlan(
	overrides: Partial<SearchPlan> = {},
): FindCompaniesDeps["synthesize"] {
	const plan = testPlan({
		recency: "a role posted in the last 30 days",
		recencyDays: 30,
		source: "exa-agent",
		...overrides,
	});
	return async () => ({
		route: "agent",
		plans: [plan],
		ledger: new CostLedger(),
	});
}

function searchPlan(
	overrides: Partial<SearchPlan> = {},
): FindCompaniesDeps["synthesize"] {
	const plan = testPlan(overrides);
	return async () => ({
		route: "search",
		plans: [plan],
		ledger: new CostLedger(),
	});
}

const noopJudge: FindCompaniesDeps["judge"] = async (requirements, rows) => ({
	verdicts: rows.map((_row, index) => ({
		index,
		statuses: requirements
			.filter((r) => r.kind === "hard")
			.map((r) => ({ id: r.id, status: "proven" as const })),
		soft: [],
		reason: "fits icp",
		sameOrganizationAs: null,
	})),
	ledger: new CostLedger(),
});

const passthroughBackfill: FindCompaniesDeps["backfill"] = async (domains) =>
	domains.map((domain) => ({ domain, record: null }));

const icp = { description: "fintech companies" };

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("a round that demanded proof checks its own evidence before the judge sees it", () => {
	it("rejects a page that truly does not exist, keeps one that merely lacks the quote, and keeps one the crawler refused", async () => {
		const good = agentRow("good.com", "Good Co is hiring now.");
		const notFound = agentRow("missing404.com", "Missing Co is hiring now.");
		const noQuote = agentRow("noquote.com", "No Quote Co is hiring now.");
		globalThis.fetch = exaContentsFetch({
			"https://good.com/careers": { text: "Good Co is hiring now." },
			"https://missing404.com/careers": { errorTag: "CRAWL_NOT_FOUND" },
			"https://noquote.com/careers": { text: "Nothing about hiring here." },
		});
		const { agentRound } = scriptedAgentRound([[good, notFound, noQuote]]);

		const result = await findCompanies(icp, 3, exaOptions(), {
			recentDomains: async () => [],
			synthesize: agentPlan(),
			search: async () => ({ requestId: "req-1", results: [] }),
			agentRound,
			backfill: passthroughBackfill,
			prove: async () => [],
			gate,
			judge: noopJudge,
		});

		expect(result.companies.map((row) => row.domain).sort()).toEqual([
			"good.com",
			"noquote.com",
		]);
		expect(result.captures["good.com"]?.result.evidenceCheck).toBe("found");
		expect(result.captures["noquote.com"]?.result.evidenceCheck).toBe(
			"missing",
		);
		expect(
			result.rejects.some((reject) => reject.reason === "CRAWL_NOT_FOUND"),
		).toBe(true);
	});

	it("records an evidenceCheck and a proving page for every one of a dozen quoted companies from one agent round", async () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			agentRow(`co${i}.example`, `Co ${i} is hiring now.`),
		);
		const byUrl = Object.fromEntries(
			rows.map((_row, i) => [
				`https://co${i}.example/careers`,
				{ text: `Co ${i} is hiring now.` },
			]),
		);
		globalThis.fetch = exaContentsFetch(byUrl);
		const { agentRound } = scriptedAgentRound([rows]);

		const result = await findCompanies(icp, 12, exaOptions(), {
			recentDomains: async () => [],
			synthesize: agentPlan(),
			search: async () => ({ requestId: "req-1", results: [] }),
			agentRound,
			backfill: passthroughBackfill,
			prove: async () => [],
			gate,
			judge: noopJudge,
		});

		expect(result.companies).toHaveLength(12);
		expect(result.pages).toHaveLength(12);
	});
});

describe("a round that demanded proof but never had it to check", () => {
	it("rejects a row with no evidence quote at all", async () => {
		const noQuoteAtAll: ExaResult = {
			...goodResult("silent.com"),
			evidenceUrl: "https://silent.com/careers",
		};
		globalThis.fetch = async () => {
			throw new Error("no fetch should run for a row with no quote to check");
		};
		const { agentRound } = scriptedAgentRound([[noQuoteAtAll]]);

		const result = await findCompanies(icp, 1, exaOptions(), {
			recentDomains: async () => [],
			synthesize: agentPlan(),
			search: async () => ({ requestId: "req-1", results: [] }),
			agentRound,
			backfill: passthroughBackfill,
			prove: async () => [],
			gate,
			judge: noopJudge,
		});

		expect(result.companies).toHaveLength(0);
		expect(
			result.rejects.some((reject) => reject.reason === "missing-required"),
		).toBe(true);
	});

	it("never fetches a page for a round whose plan asked the agent for no proof", async () => {
		globalThis.fetch = async () => {
			throw new Error("no fetch should run when the plan asked for no proof");
		};
		const { agentRound } = scriptedAgentRound([[goodResult("plain.com")]]);

		const result = await findCompanies(icp, 1, exaOptions(), {
			recentDomains: async () => [],
			synthesize: agentPlan({ recency: null, recencyDays: null }),
			search: async () => ({ requestId: "req-1", results: [] }),
			agentRound,
			backfill: passthroughBackfill,
			prove: async () => [],
			gate,
			judge: noopJudge,
		});

		expect(result.companies.map((row) => row.domain)).toEqual(["plain.com"]);
	});
});

describe("captures across sources agree on shape", () => {
	it("captures an agent-sourced company under the same shape as a search-sourced one", async () => {
		const agentCompany: ExaAgentCompany = {
			name: "Agent Co",
			website: "https://agentco.com",
			linkedinUrl: null,
			description: "found by the agent",
			industry: null,
			foundedYear: 2020,
			workforceTotal: 12,
			city: "Austin",
			country: "United States",
			revenueAnnual: null,
			fundingTotal: null,
			signal: "opened a platform engineering role",
			evidenceUrl: "https://jobs.example.com/agent-co/platform",
			evidenceDate: "2026-08-12",
			evidenceQuote: "Agent Co is hiring a Platform Engineer.",
			evidencePublisher: "Agent Co Careers",
			evidenceKind: null,
		};
		const agentSearchResult = toExaSearchResult("req-1", [agentCompany]);

		const result = await findCompanies(icp, 1, exaOptions(), {
			recentDomains: async () => [],
			synthesize: searchPlan(),
			search: async () => agentSearchResult,
			agentRound: async () => {
				throw new Error("should not reach the agent");
			},
			backfill: passthroughBackfill,
			prove: async () => [],
			gate,
			judge: noopJudge,
		});

		const capture = result.captures["agentco.com"];
		expect(capture ? Object.keys(capture).sort() : []).toEqual([
			"entity",
			"raw",
			"result",
			"source",
		]);
		expect(result.companies.map((row) => row.domain)).toEqual(["agentco.com"]);
	});
});
