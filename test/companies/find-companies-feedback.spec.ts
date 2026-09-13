import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { gate } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import type {
	CompanyEntity,
	ExaResult,
	ExaSearchRequest,
} from "@/core/providers/exa/search";
import { conditionRefs } from "@/core/requirements";
import type { IcpDoc, SearchPlan, SynthesizeInput } from "@/core/synthesize";
import { companyIdentityEvidence } from "../support/companies";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture(
	{ offer: "Fintech software", buyer: "Revenue leaders" },
	"Find fintech companies at seed stage in San Francisco with a small team.",
);

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

function testDeps(
	overrides: Partial<FindCompaniesDeps> &
		Pick<
			FindCompaniesDeps,
			"recentDomains" | "synthesize" | "search" | "gate" | "judge"
		>,
): FindCompaniesDeps {
	return {
		agentRound: async () => {
			throw new Error("this round should not have reached the agent");
		},
		backfill: async () => {
			throw new Error("this round should not have backfilled a record");
		},
		retrieveEvidence: async ({ rows }) => ({
			evidenceByRow: companyIdentityEvidence(rows),
			pages: [],
		}),
		...overrides,
	};
}

function testOptions(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: testEnv,
		today: "2026-08-30",
		requirements: [requirementFixture("the company fits the profile")],
		...overrides,
	};
}

function testPlan(overrides: Partial<SearchPlan> = {}): SearchPlan {
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
		...overrides,
	};
}

function scriptedSearch(rounds: ExaResult[][]) {
	const calls: ExaSearchRequest[] = [];
	const search: FindCompaniesDeps["search"] = async (
		_plan,
		req,
		_env,
		ledger,
	) => {
		const results = rounds[calls.length] ?? [];
		calls.push(req);
		ledger.reported("exa", "search", 0.01);
		return { requestId: `req-${calls.length}`, results };
	};
	return { search, calls };
}

function scriptedSynthesize(planOverrides: Partial<SearchPlan> = {}) {
	const inputs: SynthesizeInput[] = [];
	const synthesize: FindCompaniesDeps["synthesize"] = async (input) => {
		inputs.push(input);
		const ledger = new CostLedger();
		ledger.reported("worker-model", "synthesize", 0.001);
		return {
			route: "search" as const,
			plans: [
				testPlan({
					query: `${input.icp.icp.offer ?? "companies"} round-${inputs.length}`,
					angle: `angle-${inputs.length}`,
					...planOverrides,
				}),
			],
			ledger,
		};
	};
	return { synthesize, inputs };
}

function scriptedJudge(rejectsByCall: number[][]): FindCompaniesDeps["judge"] {
	let call = 0;
	return async (requirements, rows) => {
		const rejects = rejectsByCall[call] ?? [];
		call += 1;
		const ledger = new CostLedger();
		ledger.reported("reasoning-model", "judge", 0.002);
		const refs = conditionRefs(requirements);
		const verdicts: Verdict[] = rows.map((_row, index) => ({
			index,
			statuses: refs.map((ref) => ({
				id: ref.id,
				status: rejects.includes(index) ? "contradicted" : "proven",
				sourceUrl: null,
				date: null,
			})),
			reason: rejects.includes(index) ? "does not fit icp" : "fits icp",
		}));
		return { verdicts, ledger };
	};
}

function recordingRecentDomains(domains: string[] = []) {
	const calls: Array<{ organizationId: string }> = [];
	const recentDomains: FindCompaniesDeps["recentDomains"] = async (
		_env,
		organizationId,
	) => {
		calls.push({ organizationId });
		return domains;
	};
	return { recentDomains, calls };
}

type RunExtras = {
	rejectsByCall?: number[][];
	optionOverrides?: Partial<FindCompaniesOptions>;
	planOverrides?: Partial<SearchPlan>;
	seen?: string[];
};

function run(count: number, rounds: ExaResult[][], extras: RunExtras = {}) {
	const {
		rejectsByCall = [],
		optionOverrides = {},
		planOverrides = {},
		seen = [],
	} = extras;
	const { search } = scriptedSearch(rounds);
	const { synthesize } = scriptedSynthesize(planOverrides);
	const { recentDomains } = recordingRecentDomains(seen);
	return findCompanies(
		icp,
		count,
		testOptions(optionOverrides),
		testDeps({
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge(rejectsByCall),
		}),
	);
}

describe("collapsing numeric reject reasons for the synthesizer's feedback", () => {
	it("groups missing requirements for recovery while retaining the judge's explanation", async () => {
		const below = Array.from({ length: 5 }, (_, i) =>
			goodResult(`low${i}.com`, { workforceTotal: 10 + i }),
		);
		const grouped = await run(5, [below], {
			planOverrides: { minWorkforce: 20 },
		});
		expect(grouped.rejects).toHaveLength(5);

		const ungrouped = await run(1, [[goodResult("wrong.com")]], {
			rejectsByCall: [[0]],
		});
		expect(ungrouped.rejects[0]).toEqual({
			domain: "wrong.com",
			reason: "contradicts r1.a1.c1: does not fit icp",
			stage: "judge",
			group: "proof gap for required group r1",
			statuses: [
				{ id: "r1.a1.c1", status: "contradicted", sourceUrl: null, date: null },
			],
		});
		expect(ungrouped.feedback).toEqual([
			"Previous round used search, admitted 0 companies; 1 companies still needed.",
			"1 company had a proof gap for required group r1",
		]);
	});
});

describe("findCompanies — cost and dependency wiring", () => {
	it("reports admitted companies and the remaining count to the next round", async () => {
		const outcome = await run(2, [[goodResult("accepted.com")]]);
		expect(outcome.feedback[0]).toBe(
			"Previous round used search, admitted 1 companies; 1 companies still needed.",
		);
	});

	it("reports costDollars as the merged total across every round and both model calls", async () => {
		const outcome = await run(2, [
			[goodResult("cost1.com")],
			[goodResult("cost2.com")],
		]);

		expect(outcome.costDollars).toBeCloseTo(0.001 + 0.01 + 0.002, 9);
	});

	it("reads seen domains through the injected recentDomains dependency, scoped to the account", async () => {
		const { search } = scriptedSearch([[goodResult("acme.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains, calls } = recordingRecentDomains(["known.com"]);

		await findCompanies(
			icp,
			1,
			testOptions({ organizationId: "org-42" }),
			testDeps({
				recentDomains,
				synthesize,
				search,
				gate,
				judge: scriptedJudge([]),
			}),
		);

		expect(calls).toEqual([
			{
				organizationId: "org-42",
			},
		]);
	});
});
