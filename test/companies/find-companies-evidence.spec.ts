import { afterEach, describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { toExaSearchResult } from "@/core/companies/agent-search";
import { gate } from "@/core/companies/gate";
import type { EvidenceByRow } from "@/core/companies/judge-evidence";
import { CostLedger } from "@/core/cost";
import type { ExaAgentCompany } from "@/core/providers/exa/agent";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import { conditionRefs } from "@/core/requirements";
import type { SearchPlan } from "@/core/synthesize";
import { companyIdentityEvidence } from "../support/companies";
import { fakeSecretEnv } from "../support/env";
import { profileFixture, requirementFixture } from "../support/icp";

function goodResult(
	domain: string,
	overrides: Partial<CompanyEntity> = {},
): ExaResult {
	return {
		id: `https://exa.ai/library/organization/${domain}`,
		url: `https://${domain}/`,
		title: `Company ${domain}`,
		summary: null,
		company: {
			name: `Company ${domain}`,
			description: "a small software company",
			industry: null,
			foundedYear: 2021,
			workforceTotal: 8,
			city: "San Francisco",
			country: "United States",
			revenueAnnual: null,
			fundingTotal: null,
			...overrides,
		},
		person: null,
	};
}

function agentRow(domain: string, _quote: string): ExaResult {
	return {
		...goodResult(domain),
	};
}
function exaOptions(): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
		today: "2026-08-30",
		requirements: [requirementFixture("the company fits the profile")],
	};
}
function scriptedAgentRound(rounds: ExaResult[][]) {
	const calls: Array<readonly string[]> = [];
	const agentRound: FindCompaniesDeps["agentRound"] = async (
		_plans,
		excludeDomains,
		_env,
		ledger,
	) => {
		const results = rounds[calls.length] ?? [];
		calls.push(excludeDomains);
		ledger.reported("exa", "agent", 0.02);
		return { requestId: `agent-${calls.length}`, results };
	};
	return { agentRound, calls };
}
function testPlan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "companies",
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
		...overrides,
	};
}
function agentPlan(
	overrides: Partial<SearchPlan> = {},
): FindCompaniesDeps["synthesize"] {
	const plan = testPlan({
		source: "exa-agent",
		...overrides,
	});
	return async () => ({
		route: "agent",
		plans: [plan],
		ledger: new CostLedger(),
	});
}
function searchPlan(
	overrides: Partial<SearchPlan> = {},
): FindCompaniesDeps["synthesize"] {
	const plan = testPlan(overrides);
	return async () => ({
		route: "search",
		plans: [plan],
		ledger: new CostLedger(),
	});
}
const noopJudge: FindCompaniesDeps["judge"] = async (requirements, rows) => ({
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
});
const sourceAwareJudge: FindCompaniesDeps["judge"] = async (
	requirements,
	rows,
	_env,
	options,
) => ({
	verdicts: rows.map((row, index) => {
		const evidence = options?.evidenceByRow?.get(index);
		const sourceUrl = `https://${row.domain}/careers`;
		const proven = Boolean(evidence?.get(sourceUrl)?.text);
		return {
			index,
			statuses: conditionRefs(requirements).map(({ id }) => ({
				id,
				status: proven ? ("proven" as const) : ("unproven" as const),
				sourceUrl: proven ? sourceUrl : null,
				date: null,
			})),
			reason: proven
				? "source page established the requirement"
				: "source evidence was absent",
		};
	}),
	ledger: new CostLedger(),
});

const passthroughBackfill: FindCompaniesDeps["backfill"] = async (domains) =>
	domains.map((domain) => ({ domain, record: null }));

const icp = profileFixture(
	{ offer: "Fintech software" },
	"Find fintech companies.",
);

const goodEvidenceByRow: EvidenceByRow = new Map([
	[
		0,
		new Map([
			[
				"https://good.com/careers",
				{
					url: "https://good.com/careers",
					quote: "",
					text: "Good Co is hiring now.",
				},
			],
		]),
	],
]);

const goodPages = [
	{
		domain: "good.com",
		url: "https://good.com/careers",
		text: "Good Co is hiring now.",
	},
];

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("a round passes retrieved source evidence to the judge", () => {
	it("keeps only a row whose required source evidence was retrieved", async () => {
		const good = agentRow("good.com", "Good Co is hiring now.");
		const { agentRound } = scriptedAgentRound([
			[good, agentRow("missing404.com", "")],
		]);

		const result = await findCompanies(icp, 3, exaOptions(), {
			recentDomains: async () => [],
			synthesize: agentPlan(),
			search: async () => ({ requestId: "req-1", results: [] }),
			agentRound,
			backfill: passthroughBackfill,
			retrieveEvidence: async ({ rows }) => {
				const evidenceByRow = new Map(companyIdentityEvidence(rows));
				rows.forEach((row, index) => {
					if (row.domain === "good.com")
						evidenceByRow.set(
							index,
							new Map([
								...(evidenceByRow.get(index) ?? []),
								...(goodEvidenceByRow.get(0) ?? []),
							]),
						);
				});
				return { evidenceByRow, pages: goodPages };
			},
			gate,
			judge: sourceAwareJudge,
		});

		expect(result.companies.map((row) => row.domain)).toEqual(["good.com"]);
		expect(
			result.rejects.some((reject) =>
				reject.reason.includes("required condition"),
			),
		).toBe(true);
	});
});
describe("a round without retrieved source evidence", () => {
	it("rejects a row whose required condition remains unproven", async () => {
		const noQuoteAtAll: ExaResult = {
			...goodResult("silent.com"),
		};
		const { agentRound } = scriptedAgentRound([[noQuoteAtAll]]);

		const result = await findCompanies(icp, 1, exaOptions(), {
			recentDomains: async () => [],
			synthesize: agentPlan(),
			search: async () => ({ requestId: "req-1", results: [] }),
			agentRound,
			backfill: passthroughBackfill,
			retrieveEvidence: async ({ rows }) => ({
				evidenceByRow: companyIdentityEvidence(rows),
				pages: [],
			}),
			gate,
			judge: sourceAwareJudge,
		});
		expect(result.companies).toHaveLength(0);
		expect(
			result.rejects.some((reject) =>
				reject.reason.includes("required condition"),
			),
		).toBe(true);
	});
});

function agentCoCompany(): ExaAgentCompany {
	return {
		name: "Agent Co",
		website: "https://agentco.com",
		linkedinUrl: null,
		description: "found by the agent",
		industry: null,
		foundedYear: 2020,
		workforceTotal: 12,
		city: "Austin",
		country: "United States",
		revenueAnnual: null,
		fundingTotal: null,
		evidence: [],
	};
}
describe("captures across sources agree on shape", () => {
	it("captures an agent-sourced company under the same shape as a search-sourced one", async () => {
		const agentSearchResult = toExaSearchResult("req-1", [agentCoCompany()]);

		const result = await findCompanies(icp, 1, exaOptions(), {
			recentDomains: async () => [],
			synthesize: searchPlan(),
			search: async () => agentSearchResult,
			agentRound: async () => {
				throw new Error("should not reach the agent");
			},
			backfill: passthroughBackfill,
			retrieveEvidence: async ({ rows }) => ({
				evidenceByRow: companyIdentityEvidence(rows),
				pages: [],
			}),
			gate,
			judge: noopJudge,
		});

		const capture = result.captures["agentco.com"];
		expect(capture?.entity).toBeDefined();
		expect(capture?.raw).toBeDefined();
		expect(result.companies.map((row) => row.domain)).toEqual(["agentco.com"]);
	});
});
