import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import { filterEntities, toCompanyData } from "@/core/companies/candidates";
import { gate } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import { conditionRefs } from "@/core/requirements";
import type { SearchPlan } from "@/core/synthesize";
import { companyIdentityEvidence } from "../support/companies";
import { profileFixture, requirementFixture } from "../support/icp";

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
function result(
	domain: string,
	overrides: Partial<CompanyEntity> = {},
): ExaResult {
	return {
		id: `exa-${domain}`,
		url: `https://${domain}/`,
		title: `Company ${domain}`,
		summary: null,
		company: entity({ name: `Company ${domain}`, ...overrides }),
		person: null,
	};
}
function plan(): SearchPlan {
	return {
		query: "fintech companies",
		angle: "angle-1",
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
	};
}
const today = "2026-08-30";

describe("candidate filtering and capture", () => {
	it("keeps the vendor entity in the capture while producing the canonical row", () => {
		const outcome = filterEntities(
			[result("rich.com", { workforceTotal: 42 })],
			plan(),
			today,
		);
		expect(outcome.rows[0]).toEqual({
			name: "Company rich.com",
			domain: "rich.com",
			linkedinUrl: null,
			description: "a small software company",
			record: outcome.rows[0]?.record,
		});
		expect(outcome.captures["rich.com"]?.entity.workforceTotal).toBe(42);
	});

	it("rejects a result without a company record", () => {
		const outcome = filterEntities(
			[{ ...result("missing.com"), company: null }],
			plan(),
			today,
		);
		expect(outcome.rows).toEqual([]);
		expect(outcome.rejects[0]?.stage).toBe("filter");
	});
});

function deps(): FindCompaniesDeps {
	return {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: "search",
			plans: [plan()],
			ledger: new CostLedger(),
		}),
		search: async () => ({ requestId: "req-1", results: [result("kept.com")] }),
		agentRound: async () => ({ requestId: "agent-1", results: [] }),
		backfill: async () => [],
		retrieveEvidence: async ({ rows }) => ({
			evidenceByRow: companyIdentityEvidence(rows),
			pages: [],
		}),
		gate,
		judge: async (requirements, rows) => ({
			verdicts: rows.map((_row, index) => ({
				index,
				statuses: conditionRefs(requirements).map(({ id }) => ({
					id,
					status: "proven" as const,
					sourceUrl: null,
					date: null,
				})),
				reason: "fits icp",
			})),
			ledger: new CostLedger(),
		}),
	};
}

describe("candidate capture conversion", () => {
	it("carries the judge qualification into the canonical match", async () => {
		const options: FindCompaniesOptions = {
			icpId: "icp-1",
			organizationId: "org-1",
			env: testEnv,
			today,
			requirements: [requirementFixture("fits the profile")],
		};
		const found = await findCompanies(profileFixture(), 1, options, deps());
		const capture = found.captures["kept.com"];
		if (!capture) throw new Error("expected capture");
		expect(capture.result.qualification?.reason).toBe("fits icp");
		expect(toCompanyData(capture).result.qualification?.reason).toBe(
			"fits icp",
		);
	});

	it("preserves the selected provider on converted data", () => {
		const capture: CompanyCapture = {
			entity: entity(),
			result: {
				id: "id",
				url: "https://example.com",
				title: "Example",
				qualification: null,
			},
			evidence: [],
			raw: "{}",
			source: "exa-agent",
		};
		expect(toCompanyData(capture).provider).toBe("exa-agent");
	});
});
