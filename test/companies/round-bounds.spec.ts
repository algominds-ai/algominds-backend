import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { gate } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import type { IcpDoc } from "@/core/synthesize";
import { companyIdentityEvidence } from "../support/companies";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture();

function searchPlan() {
	return {
		query: "banks",
		angle: "banking",
		source: "exa-search" as const,
		agentEffort: "low" as const,
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

function options(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: testEnv,
		today: "2026-09-03",
		requirements: [requirementFixture("the company is a bank")],
		...overrides,
	};
}

describe("findCompanies runs one round", () => {
	it("returns the current round without retrying", async () => {
		let rounds = 0;
		const deps: FindCompaniesDeps = {
			recentDomains: async () => [],
			synthesize: async () => ({
				route: "search",
				plans: [searchPlan()],
				ledger: new CostLedger(),
			}),
			search: async () => {
				rounds += 1;
				return { requestId: `req-${rounds}`, results: [] };
			},
			agentRound: async () => {
				throw new Error("should not reach the agent");
			},
			backfill: async () => [],
			retrieveEvidence: async ({ rows }) => ({
				evidenceByRow: companyIdentityEvidence(rows),
				pages: [],
			}),
			gate,
			judge: async () => ({ verdicts: [], ledger: new CostLedger() }),
		};

		const result = await findCompanies(icp, 10, options(), deps);

		expect(rounds).toBe(1);
		expect(result.rounds).toBe(1);
		expect(result.status).toBe("empty");
	});
});
