import { describe, expect, it } from "vitest";
import { filterEntities } from "@/core/companies/candidates";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import type { SearchPlan } from "@/core/synthesize";

function entity(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
	return {
		name: "Company",
		description: null,
		industry: null,
		foundedYear: null,
		workforceTotal: 40,
		city: null,
		country: "United States",
		revenueAnnual: null,
		fundingTotal: null,
		...overrides,
	};
}

function result(domain: string, company: CompanyEntity): ExaResult {
	return {
		id: null,
		url: `https://${domain}/`,
		title: domain,
		summary: null,
		person: null,
		company,
	};
}

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "seed stage startups",
		angle: "the profile as written",
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

const financialBand: Partial<SearchPlan> = {
	minRevenueAnnual: 5_000_000,
	maxRevenueAnnual: 50_000_000,
	minFundingTotal: 1_000_000,
	maxFundingTotal: 20_000_000,
};

describe("revenue and funding raised count as one alternative band", () => {
	it("keeps a company whose revenue is in band even when its funding is below the floor", () => {
		const outcome = filterEntities(
			[
				result(
					"revenue-in-band.com",
					entity({ revenueAnnual: 10_000_000, fundingTotal: 50_000 }),
				),
			],
			plan(financialBand),
			"2026-09-03",
		);
		expect(outcome.rejects).toEqual([]);
		expect(outcome.rows.map((row) => row.domain)).toEqual([
			"revenue-in-band.com",
		]);
	});

	it("rejects with the revenue reason when both revenue and funding are below their floors", () => {
		const outcome = filterEntities(
			[
				result(
					"both-below.com",
					entity({ revenueAnnual: 1_000_000, fundingTotal: 50_000 }),
				),
			],
			plan(financialBand),
			"2026-09-03",
		);
		expect(outcome.rejects.map((reject) => reject.reason)).toEqual([
			"annual revenue 1000000 below the floor of 5000000",
		]);
		expect(outcome.rows).toEqual([]);
	});

	it("rejects on funding alone when the plan bounds only funding and it is below the floor", () => {
		const outcome = filterEntities(
			[result("only-funding.com", entity({ fundingTotal: 50_000 }))],
			plan({ minFundingTotal: 1_000_000, maxFundingTotal: 20_000_000 }),
			"2026-09-03",
		);
		expect(outcome.rejects.map((reject) => reject.reason)).toEqual([
			"funding raised 50000 below the floor of 1000000",
		]);
		expect(outcome.rows).toEqual([]);
	});

	it("still rejects on workforce above the ceiling even when revenue is in band", () => {
		const outcome = filterEntities(
			[
				result(
					"big-but-funded.com",
					entity({
						workforceTotal: 500,
						revenueAnnual: 10_000_000,
						fundingTotal: 50_000,
					}),
				),
			],
			plan({ ...financialBand, maxWorkforce: 20 }),
			"2026-09-03",
		);
		expect(outcome.rejects.map((reject) => reject.reason)).toEqual([
			"headcount 500 above the limit of 20",
		]);
		expect(outcome.rows).toEqual([]);
	});
});
