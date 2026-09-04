import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { gate } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import type { ExaResult } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";

const icp: IcpDoc = { description: "a profile" };

const recordRequirement: Requirement = {
	id: "r1",
	text: "the company is a bank",
	kind: "hard",
	proof: "record",
	windowDays: null,
};

const pageRequirement: Requirement = {
	id: "r2",
	text: "the company published an engineering page about its platform",
	kind: "hard",
	proof: "page",
	windowDays: 730,
};

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		soft: [],
		reason: "a reason",
		sameOrganizationAs: null,
		...overrides,
	};
}

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "banks",
		angle: "banking",
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

function exaResult(domain: string, workforce: number | null): ExaResult {
	return {
		id: null,
		url: `https://${domain}/`,
		title: domain,
		summary: null,
		person: null,
		company: {
			name: domain,
			description: "a company",
			industry: null,
			foundedYear: null,
			workforceTotal: workforce,
			city: null,
			country: "United Kingdom",
			revenueAnnual: null,
			fundingTotal: null,
		},
	};
}

function options(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: testEnv,
		today: "2026-09-03",
		requirements: [recordRequirement],
		maxRounds: 1,
		...overrides,
	};
}

type AgentDeps = {
	deps: FindCompaniesDeps;
	agentExclusions: Array<readonly string[]>;
	backfilled: Array<readonly string[]>;
};

function agentDeps(
	results: ExaResult[],
	verdicts?: (rows: readonly { domain: string | null }[]) => Verdict[],
): AgentDeps {
	const agentExclusions: Array<readonly string[]> = [];
	const backfilled: Array<readonly string[]> = [];
	const deps: FindCompaniesDeps = {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: "agent",
			plans: [plan({ source: "exa-agent" })],
			ledger: new CostLedger(),
		}),
		search: async () => ({ requestId: "req-1", results: [] }),
		agentRound: async (_plans, excludeDomains) => {
			agentExclusions.push(excludeDomains);
			return { requestId: "agent-1", results };
		},
		backfill: async (domains) => {
			backfilled.push(domains);
			return domains.map((domain) => ({ domain, record: null }));
		},
		prove: async () => [],
		gate,
		judge: async (_requirements, rows) => ({
			verdicts: verdicts
				? verdicts(rows)
				: rows.map((_row, index) =>
						verdict({
							index,
							statuses: [
								{ id: "r1", status: "proven" },
								{ id: "r2", status: "proven" },
							],
						}),
					),
			ledger: new CostLedger(),
		}),
	};
	return { deps, agentExclusions, backfilled };
}

describe("a company this account already holds never comes back, on either route", () => {
	it("keeps an excluded company out of a stored search round", async () => {
		const deps: FindCompaniesDeps = {
			...agentDeps([]).deps,
			synthesize: async () => ({
				route: "search",
				plans: [plan()],
				ledger: new CostLedger(),
			}),
			search: async () => ({
				requestId: "req-1",
				results: [exaResult("seen.com", 900), exaResult("fresh.com", 900)],
			}),
		};

		const result = await findCompanies(
			icp,
			2,
			options({ excludeDomains: ["seen.com"] }),
			deps,
		);

		expect(result.companies.map((company) => company.domain)).toEqual([
			"fresh.com",
		]);
	});

	it("keeps an excluded company, and a brand of it, out of a stored agent round, never spending a lookup on it", async () => {
		const spy = agentDeps(
			[exaResult("jobs.barclays", 900), exaResult("fresh.com", 900)],
			(rows) =>
				rows.map((candidate, index) =>
					verdict({
						index,
						statuses: [
							{ id: "r1", status: "proven" },
							{ id: "r2", status: "proven" },
						],
						sameOrganizationAs: candidate.domain === "jobs.barclays" ? 1 : null,
					}),
				),
		);

		const result = await findCompanies(
			icp,
			2,
			options({
				requirements: [recordRequirement, pageRequirement],
				excludeDomains: ["home.barclays"],
			}),
			spy.deps,
		);

		expect(result.companies.map((company) => company.domain)).not.toContain(
			"jobs.barclays",
		);
		expect(spy.agentExclusions[0]).toContain("home.barclays");
		expect(spy.backfilled[0]).not.toContain("home.barclays");
	});

	it("names the excluded companies in every fanned-out agent request", async () => {
		const spy = agentDeps([exaResult("fresh.com", 900)]);

		await findCompanies(
			icp,
			1,
			options({
				requirements: [recordRequirement, pageRequirement],
				excludeDomains: ["seen.com"],
			}),
			spy.deps,
		);

		expect(spy.agentExclusions[0]).toContain("seen.com");
	});
});

describe("an agent-found company is bounded by the vendor's record, not its own claim", () => {
	it("refuses an agent company the vendor's own record puts outside the bounds", async () => {
		const spy = agentDeps([exaResult("small.com", 900)]);
		const boundedDeps: FindCompaniesDeps = {
			...spy.deps,
			synthesize: async () => ({
				route: "agent",
				plans: [plan({ source: "exa-agent", minWorkforce: 500 })],
				ledger: new CostLedger(),
			}),
			backfill: async (domains) =>
				domains.map((domain) => ({ domain, record: exaResult(domain, 12) })),
		};

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			boundedDeps,
		);

		expect(result.companies).toHaveLength(0);
		expect(
			result.rejects.some((reject) => reject.reason.includes("headcount 12")),
		).toBe(true);
	});
});
