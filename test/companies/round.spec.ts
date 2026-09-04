import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import type { CompanyRow } from "@/core/companies/gate";
import { gate } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import type { ProvingHit } from "@/core/companies/proof";
import { CostLedger } from "@/core/cost";
import type { ExaResult } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import { hardPageRequirements } from "@/core/requirements";
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

const pageRequirement2: Requirement = {
	id: "r4",
	text: "the company published a security compliance page",
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

type RoundSpy = {
	deps: FindCompaniesDeps;
	order: string[];
	agentExclusions: Array<readonly string[]>;
	backfilled: Array<readonly string[]>;
};

type RoundScript = {
	route: "search" | "agent";
	requirements: readonly Requirement[];
	results: ExaResult[];
	hits?: Record<string, ProvingHit>;
	verdicts?: (rows: readonly CompanyRow[]) => Verdict[];
};

function spyingDeps(script: RoundScript): RoundSpy {
	const order: string[] = [];
	const agentExclusions: Array<readonly string[]> = [];
	const backfilled: Array<readonly string[]> = [];
	const deps: FindCompaniesDeps = {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: script.route,
			plans: [
				plan({ source: script.route === "agent" ? "exa-agent" : "exa-search" }),
			],
			ledger: new CostLedger(),
		}),
		search: async () => {
			order.push("search");
			return { requestId: "req-1", results: script.results };
		},
		agentRound: async (_plans, excludeDomains) => {
			order.push("agent");
			agentExclusions.push(excludeDomains);
			return { requestId: "agent-1", results: script.results };
		},
		backfill: async (domains) => {
			backfilled.push(domains);
			return domains.map((domain) => ({ domain, record: null }));
		},
		prove: async (rows) => {
			order.push("prove");
			return rows.map((candidate, index) => ({
				index,
				hit: script.hits?.[candidate.domain ?? ""] ?? null,
			}));
		},
		gate,
		judge: async (_requirements, rows) => {
			order.push("judge");
			return {
				verdicts: script.verdicts
					? script.verdicts(rows)
					: rows.map((_row, index) =>
							verdict({
								index,
								statuses: hardPageRequirements(script.requirements).map(
									(req) => ({
										id: req.id,
										status: "proven",
									}),
								),
							}),
						),
				ledger: new CostLedger(),
			};
		},
	};
	return { deps, order, agentExclusions, backfilled };
}

describe("the route a round runs on comes from its requirements", () => {
	it("sends a search round to the company index, never the agent", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(icp, 1, options(), spy.deps);

		expect(spy.order).toContain("search");
		expect(spy.order).not.toContain("agent");
	});

	it("sends an agent round to the fan-out and backfills every record it named", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).toContain("agent");
		expect(spy.order).not.toContain("search");
		expect(spy.backfilled[0]).toEqual(["bank.com"]);
	});
});

function hitFor(requirementId: string): ProvingHit {
	return requirementId === pageRequirement.id
		? {
				url: "https://bank.com/engineering",
				quote: "we run our own platform",
				publishedDate: "2026-01-01",
				text: "we run our own platform",
			}
		: {
				url: "https://bank.com/security",
				quote: "SOC 2 type II certified",
				publishedDate: "2026-01-01",
				text: "SOC 2 type II certified",
			};
}

describe("proving runs before the judge, and every hard page requirement gets its own proof", () => {
	it("proves every candidate of a search round, hands the judge the proved page, and keeps the page retrieved", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
			hits: {
				"bank.com": {
					url: "https://bank.com/engineering",
					quote: "we run our own platform",
					publishedDate: "2026-01-01",
					text: "the whole page text",
				},
			},
		});

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).toEqual(["search", "prove", "judge"]);
		expect(result.pages).toEqual([
			{
				domain: "bank.com",
				url: "https://bank.com/engineering",
				text: "the whole page text",
			},
		]);
		expect(result.captures["bank.com"]?.result.evidenceCheck).toBe("found");
	});

	it("proves each hard page requirement separately, giving the judge every page found", async () => {
		const proveCalls: string[] = [];
		const spy = spyingDeps({
			route: "search",
			requirements: [pageRequirement, pageRequirement2],
			results: [exaResult("bank.com", 900)],
		});
		const deps: FindCompaniesDeps = {
			...spy.deps,
			prove: async (rows, requirement) => {
				proveCalls.push(requirement.id);
				const hit = hitFor(requirement.id);
				return rows.map((_candidate, index) => ({ index, hit }));
			},
		};

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [pageRequirement, pageRequirement2] }),
			deps,
		);

		expect(proveCalls.sort()).toEqual([
			pageRequirement.id,
			pageRequirement2.id,
		]);
		expect(result.pages.map((page) => page.url).sort()).toEqual([
			"https://bank.com/engineering",
			"https://bank.com/security",
		]);
	});

	it("never proves on an agent round, because the agent already cited its page", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).not.toContain("prove");
	});
});
