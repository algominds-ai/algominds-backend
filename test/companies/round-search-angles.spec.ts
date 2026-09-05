import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { gate } from "@/core/companies/gate";
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

function exaResult(domain: string): ExaResult {
	return {
		id: null,
		url: `https://${domain}/`,
		title: domain,
		summary: null,
		person: null,
		company: {
			name: domain,
			description: "a bank",
			industry: null,
			foundedYear: null,
			workforceTotal: 900,
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

function acceptAll(): FindCompaniesDeps["judge"] {
	return async (_requirements, rows) => ({
		verdicts: rows.map((_row, index) => ({
			index,
			statuses: [],
			soft: [],
			reason: "fits",
			sameOrganizationAs: null,
		})),
		ledger: new CostLedger(),
	});
}

function twoPlanSearchDeps(searchedAngles: string[]): FindCompaniesDeps {
	return {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: "search",
			plans: [plan({ angle: "angle-a" }), plan({ angle: "angle-b" })],
			ledger: new CostLedger(),
		}),
		search: async (searchPlan) => {
			searchedAngles.push(searchPlan.angle);
			const own = searchedAngles.length === 1 ? "only-a.com" : "only-b.com";
			return {
				requestId: `req-${searchedAngles.length}`,
				results: [exaResult("shared.com"), exaResult(own)],
			};
		},
		agentRound: async () => {
			throw new Error("a search round should not reach the agent");
		},
		backfill: async () => [],
		homepages: async () => [],
		prove: async (rows) => rows.map((_row, index) => ({ index, hit: null })),
		gate,
		judge: acceptAll(),
	};
}

describe("a search round runs every angle the planner wrote", () => {
	it("searches each plan and dedupes a domain both plans returned", async () => {
		const searchedAngles: string[] = [];
		const result = await findCompanies(
			icp,
			3,
			options(),
			twoPlanSearchDeps(searchedAngles),
		);

		expect(searchedAngles).toEqual(["angle-a", "angle-b"]);
		expect(result.companies.map((c) => c.domain).sort()).toEqual([
			"only-a.com",
			"only-b.com",
			"shared.com",
		]);
	});
});
