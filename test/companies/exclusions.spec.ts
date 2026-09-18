import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { gate } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import type { ExaResult } from "@/core/providers/exa/search";
import { conditionRefs } from "@/core/requirements";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import { companyIdentityEvidence } from "../support/companies";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture();

const recordRequirement = requirementFixture("the company is a bank");

const pageRequirement = {
	...requirementFixture(
		"the company published an engineering page about its platform",
	),
	anyOf: [
		{
			allOf: [
				{
					text: "the company published an engineering page about its platform",
					window: {
						amount: 30,
						unit: "days" as const,
						appliesTo: "publication" as const,
						direction: "past" as const,
					},
					sourceRule: "company domain",
				},
			],
		},
	],
};
const requirementIds = conditionRefs([recordRequirement, pageRequirement]);

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		reason: "a reason",
		...overrides,
	};
}

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "banks",
		angle: "banking",
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
		retrieveEvidence: async ({ rows }) => ({
			evidenceByRow: companyIdentityEvidence(rows),
			pages: [],
		}),
		gate,
		judge: async (_requirements, rows) => ({
			verdicts: verdicts
				? verdicts(rows)
				: rows.map((_row, index) =>
						verdict({
							index,
							statuses: [
								{
									id: requirementIds[0]?.id ?? "r1.a1.c1",
									status: "proven",
									sourceUrl: null,
									date: null,
								},
								{
									id: requirementIds[1]?.id ?? "r2.a1.c1",
									status: "proven",
									sourceUrl: null,
									date: null,
								},
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

	it("keeps an excluded company and its provider-identified alternate domain out without looking up the excluded domain", async () => {
		const companyUrl = "https://linkedin.com/company/barclays";
		const spy = agentDeps([
			{ ...exaResult("jobs.barclays", 900), linkedinUrl: companyUrl },
			{ ...exaResult("home.barclays", 900), linkedinUrl: companyUrl },
			exaResult("fresh.com", 900),
		]);

		const result = await findCompanies(
			icp,
			2,
			options({
				requirements: [recordRequirement, pageRequirement],
				excludeDomains: ["home.barclays"],
			}),
			spy.deps,
		);

		expect(result.companies.map((company) => company.domain)).toEqual([
			"fresh.com",
		]);
		expect(result.rejects).toContainEqual(
			expect.objectContaining({
				domain: "jobs.barclays",
				reason: "already found for this account",
				stage: "gate",
			}),
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

describe("research records reach grouped qualification", () => {
	const size = requirementFixture("the company has at least 500 employees");
	const rejected = verdict({
		reason: "headcount 12 contradicts the required 500 minimum",
		statuses: [
			{ id: "r1.a1.c1", status: "contradicted", sourceUrl: null, date: null },
		],
	});
	it("refuses a research candidate when the judge contradicts a required bound", async () => {
		const boundedDeps: FindCompaniesDeps = {
			...agentDeps([exaResult("small.com", 900)]).deps,
			synthesize: async () => ({
				route: "agent",
				plans: [plan({ source: "exa-agent", minWorkforce: 500 })],
				ledger: new CostLedger(),
			}),
			backfill: async () => [
				{
					domain: "small.com",
					record: { ...exaResult("small.com", 12), id: "indexed" },
				},
			],
			judge: async (requirements, rows) => {
				expect(requirements).toEqual([size]);
				expect(rows[0]?.record?.workforceTotal).toBe(12);
				return {
					ledger: new CostLedger(),
					verdicts: [rejected],
				};
			},
		};
		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [size] }),
			boundedDeps,
		);
		expect(result.companies).toHaveLength(0);
		expect(result.rejects[0]?.stage).toBe("judge");
	});
});
