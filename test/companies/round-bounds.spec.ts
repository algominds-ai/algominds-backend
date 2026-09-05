import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { gate } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import type { IcpDoc } from "@/core/synthesize";

const icp: IcpDoc = { description: "a profile" };

function searchPlan() {
	return {
		query: "banks",
		angle: "banking",
		pageQuery: null,
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
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
		requirements: [
			{
				id: "r1",
				text: "the company is a bank",
				kind: "hard",
				proof: "record",
				windowDays: null,
			},
		],
		maxRounds: 1,
		...overrides,
	};
}

describe("the round loop stays bounded", () => {
	it("never runs more rounds than it was given, even when every round falls short", async () => {
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
			prove: async () => [],
			homepages: async () => [],
			gate,
			judge: async () => ({ verdicts: [], ledger: new CostLedger() }),
		};

		const result = await findCompanies(
			icp,
			10,
			options({ maxRounds: 3 }),
			deps,
		);

		expect(rounds).toBe(3);
		expect(result.rounds).toBe(3);
		expect(result.status).toBe("empty");
	});
});
