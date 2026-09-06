import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { gate } from "@/core/companies/gate";
import type { RequirementEvidence } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import type { ExaResult } from "@/core/providers/exa/search";
import { conditionRefs } from "@/core/requirements";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture();

const recordRequirement = requirementFixture("the company is a bank");
const recordId = conditionRefs([recordRequirement])[0]?.id ?? "r1.a1.c1";

function plan(): SearchPlan {
	return {
		query: "banks",
		angle: "banking",
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
			description: "a company",
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

function options(): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: testEnv,
		today: "2026-09-03",
		requirements: [recordRequirement],
		maxRounds: 1,
	};
}

type EvidenceByRow = ReadonlyMap<
	number,
	ReadonlyMap<string, RequirementEvidence>
>;

type Script = {
	homepages: FindCompaniesDeps["homepages"];
	onJudge?: (evidenceByRow: EvidenceByRow) => void;
};

type Harness = {
	deps: FindCompaniesDeps;
	homepageCalls: Array<readonly string[]>;
	order: string[];
};

function testDeps(script: Script): Harness {
	const homepageCalls: Array<readonly string[]> = [];
	const order: string[] = [];
	const deps: FindCompaniesDeps = {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: "search",
			plans: [plan()],
			ledger: new CostLedger(),
		}),
		search: async () => ({
			requestId: "req-1",
			results: [exaResult("bank.com")],
		}),
		agentRound: async () => {
			throw new Error("should not reach the agent");
		},
		backfill: async () => [],
		prove: async () => [],
		homepages: async (domains, env, ledger) => {
			order.push("homepages");
			homepageCalls.push(domains);
			return script.homepages(domains, env, ledger);
		},
		gate,
		judge: async (_requirements, rows, _env, options) => {
			order.push("judge");
			script.onJudge?.(options?.evidenceByRow ?? new Map());
			return {
				verdicts: rows.map((_row, index) => ({
					index,
					statuses: [{ id: recordId, status: "proven", quote: "" }],
					reason: "a reason",
					sameOrganizationAs: null,
				})),
				ledger: new CostLedger(),
			};
		},
	};
	return { deps, homepageCalls, order };
}

describe("the judge is handed each candidate's live homepage", () => {
	it("calls the homepages dep once with every judged row's domain, and hands the judge the homepage text", async () => {
		let received: EvidenceByRow = new Map();
		const harness = testDeps({
			homepages: async (domains) =>
				domains.map((domain) => ({
					domain,
					url: `https://${domain}/`,
					text: "An important update for Monolith customers",
				})),
			onJudge: (evidenceByRow) => {
				received = evidenceByRow;
			},
		});

		await findCompanies(icp, 1, options(), harness.deps);

		expect(harness.homepageCalls).toEqual([["bank.com"]]);
		expect(received.get(0)?.get("homepage")).toEqual({
			url: "https://bank.com/",
			quote: "An important update for Monolith customers",
			text: "An important update for Monolith customers",
		});
	});

	it("still judges the round normally when the homepages dep returns nothing", async () => {
		const harness = testDeps({ homepages: async () => [] });

		const result = await findCompanies(icp, 1, options(), harness.deps);

		expect(harness.order).toContain("homepages");
		expect(harness.order).toContain("judge");
		expect(result.companies.map((company) => company.domain)).toEqual([
			"bank.com",
		]);
	});
});
