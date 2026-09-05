import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import { filterEntities, toCompanyData } from "@/core/companies/candidates";
import { gate } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import type { SearchPlan } from "@/core/synthesize";

function entity(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
	return {
		name: "Example",
		description: "a small software company",
		industry: null,
		foundedYear: 2021,
		workforceTotal: 8,
		city: "San Francisco",
		country: "United States",
		revenueAnnual: null,
		fundingTotal: null,
		...overrides,
	};
}

function goodResult(
	domain: string,
	overrides: Partial<CompanyEntity> = {},
): ExaResult {
	return {
		id: `https://exa.ai/library/organization/${domain}`,
		url: `https://${domain}/`,
		title: `Company ${domain}`,
		summary: null,
		company: entity({ name: `Company ${domain}`, ...overrides }),
		person: null,
	};
}

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "fintech companies",
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

const TODAY = "2026-08-30";

describe("filterEntities — capturing the vendor payload", () => {
	it("captures the full entity, including fields the row itself never reads", () => {
		const richFields: Partial<CompanyEntity> = {
			workforceTotal: 42,
			foundedYear: 2018,
			revenueAnnual: 5_000_000,
			fundingTotal: 1_200_000,
		};

		const outcome = filterEntities(
			[goodResult("rich.com", richFields)],
			plan(),
			TODAY,
		);

		expect(outcome.captures["rich.com"]?.entity).toEqual(
			entity({ name: "Company rich.com", ...richFields }),
		);
	});

	it("captures a result missing its score and published date with those fields null, not a thrown error", () => {
		const outcome = filterEntities([goodResult("noscore.com")], plan(), TODAY);

		expect(outcome.captures["noscore.com"]?.result).toEqual({
			id: "https://exa.ai/library/organization/noscore.com",
			url: "https://noscore.com/",
			title: "Company noscore.com",
			signal: null,
			quote: null,
			publisher: null,
			kind: null,
			publishedDate: null,
			score: null,
			evidenceCheck: null,
			fitReason: null,
		});
	});

	it("carries the kind onto the row and onto the capture beside it", () => {
		const proved: ExaResult = {
			...goodResult("displaced.com"),
			evidenceUrl: "https://vendor.example/customers/displaced",
			evidenceKind: "vendor-case-study",
		};

		const outcome = filterEntities([proved], plan(), TODAY);

		expect(outcome.rows[0]?.evidenceKind).toBe("vendor-case-study");
		expect(outcome.captures["displaced.com"]?.result.kind).toBe(
			"vendor-case-study",
		);
	});
});

describe("filterEntities — what the saved row carries", () => {
	it("keeps the row to exactly the fields evidence reads, holding the vendor capture on the side", () => {
		const outcome = filterEntities([goodResult("shape.com")], plan(), TODAY);

		expect(Object.keys(outcome.rows[0] ?? {}).sort()).toEqual([
			"description",
			"domain",
			"evidenceDate",
			"evidenceKind",
			"evidencePublisher",
			"evidenceQuote",
			"evidenceUrl",
			"industry",
			"linkedinUrl",
			"name",
			"signal",
		]);
	});
});

function keptDeps(): FindCompaniesDeps {
	return {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: "search",
			plans: [plan()],
			ledger: new CostLedger(),
		}),
		search: async () => ({
			requestId: "req-1",
			results: [goodResult("kept.com")],
		}),
		agentRound: async () => {
			throw new Error("should not reach the agent");
		},
		backfill: async () => [],
		prove: async () => [],
		homepages: async () => [],
		gate,
		judge: async (requirements, rows) => ({
			verdicts: rows.map((_row, index) => ({
				index,
				statuses: requirements.map((r) => ({
					id: r.id,
					status: "proven" as const,
				})),
				reason: "fits icp",
				sameOrganizationAs: null,
			})),
			ledger: new CostLedger(),
		}),
	};
}

describe("a kept company's row carries the judge's own reason for keeping it", () => {
	it("carries the reason onto the row and onto toCompanyData's own result", async () => {
		const icp = { description: "fintech companies" };
		const options: FindCompaniesOptions = {
			icpId: "icp-1",
			organizationId: "org-1",
			env: testEnv,
			today: TODAY,
			requirements: [
				{
					id: "r1",
					text: "fits the profile",
					kind: "hard",
					proof: "record",
					windowDays: null,
				},
			],
		};

		const result = await findCompanies(icp, 1, options, keptDeps());

		const capture = result.captures["kept.com"];
		expect(capture?.result.fitReason).toBe("fits icp");
		if (!capture) throw new Error("expected a capture for kept.com");
		expect(toCompanyData(capture).result).toMatchObject({
			fitReason: "fits icp",
		});
	});
});

describe("toCompanyData", () => {
	function captureFrom(source: string): CompanyCapture {
		return {
			entity: entity(),
			result: {
				id: "https://exa.ai/library/organization/example",
				url: "https://example.com/",
				title: "Example",
				signal: null,
				quote: null,
				publisher: null,
				kind: null,
				publishedDate: null,
				score: null,
				evidenceCheck: null,
				fitReason: null,
			},
			raw: JSON.stringify(goodResult("example.com")),
			source,
		};
	}

	it("names the source the round chose, so two sources in one run stay apart", () => {
		const searched = captureFrom("exa-search");
		const agented = captureFrom("exa-agent");

		expect(toCompanyData(searched)).toEqual({
			provider: "exa-search",
			entity: searched.entity,
			result: searched.result,
		});
		expect(toCompanyData(agented).provider).toBe("exa-agent");
	});
});
