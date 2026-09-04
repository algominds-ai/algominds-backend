import { describe, expect, it } from "vitest";
import { filterEntities } from "@/core/companies/candidates";
import { statedHeadcount } from "@/core/companies/limits";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import type { SearchPlan } from "@/core/synthesize";

function entity(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
	return {
		name: "Company",
		description: null,
		industry: null,
		foundedYear: null,
		workforceTotal: 290,
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

const plan: SearchPlan = {
	query: "dental groups",
	angle: "the profile as written",
	pageQuery: null,
	recency: null,
	eventWindowDays: null,
	recencyDays: null,
	source: "exa-search",
	agentEffort: "low",
	userLocation: null,
	countries: [],
	minWorkforce: 50,
	maxWorkforce: 500,
	minFoundedYear: null,
	maxFoundedYear: null,
	minRevenueAnnual: null,
	maxRevenueAnnual: null,
	minFundingTotal: null,
	maxFundingTotal: null,
};

describe("a headcount the description states is bounded like the record's", () => {
	it("rejects a company whose own description states a headcount outside the bounds, whatever the record says", () => {
		const outcome = filterEntities(
			[
				result(
					"big.com",
					entity({
						description:
							"One of the largest dental groups, with over 140 practices, employing over 1,800 team members.",
					}),
				),
				result(
					"fine.com",
					entity({
						description:
							"A dental group with nearly one million visits a year.",
					}),
				),
			],
			plan,
			"2026-09-03",
		);

		expect(outcome.rejects.map((reject) => reject.reason)).toEqual([
			"headcount stated in the description 1800 above the limit of 500",
		]);
		expect(outcome.rows.map((row) => row.domain)).toEqual(["fine.com"]);
	});

	it("reads a stated headcount through one qualifying word and the wider staff nouns", () => {
		const stated = (description: string) =>
			statedHeadcount(entity({ description }));
		expect(
			stated("over 200 providers and more than 800 support employees"),
		).toBe(800);
		expect(stated("800+ skilled professionals across 40 states")).toBe(800);
		expect(stated("employs about 290 people")).toBe(290);
		expect(stated("serves 50,000 people a year")).toBeNull();
	});
});
