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
import { requiredConditionRefs } from "@/core/requirements";
import type { IcpDoc, SearchPlan, SynthesizeInput } from "@/core/synthesize";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture(
	{},
	"fintech companies at seed stage in San Francisco with a small team",
);

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
		prove: async () => [],
		homepages: async () => [],
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
					query: `${input.icp.instructions} round-${inputs.length}`,
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
		const verdicts: Verdict[] = rows.map((_row, index) => ({
			index,
			statuses: requiredConditionRefs(requirements).map((req) => ({
				id: req.id,
				status: rejects.includes(index) ? "contradicted" : "proven",
				quote: "",
			})),
			reason: rejects.includes(index) ? "does not fit icp" : "fits icp",
			sameOrganizationAs: null,
		}));
		return { verdicts, ledger: new CostLedger() };
	};
}

type RunExtras = {
	rejectsByCall?: number[][];
	optionOverrides?: Partial<FindCompaniesOptions>;
	seen?: string[];
	planOverrides?: Partial<SearchPlan>;
};

function run(count: number, rounds: ExaResult[][], extras: RunExtras = {}) {
	const {
		rejectsByCall = [],
		optionOverrides = {},
		seen = [],
		planOverrides = {},
	} = extras;
	const { search, calls } = scriptedSearch(rounds);
	const { synthesize, inputs } = scriptedSynthesize(planOverrides);
	return {
		calls,
		inputs,
		result: findCompanies(
			icp,
			count,
			testOptions(optionOverrides),
			testDeps({
				recentDomains: async () => seen,
				synthesize,
				search,
				gate,
				judge: scriptedJudge(rejectsByCall),
			}),
		),
	};
}
describe("a round short of its count judges its next slice before a new round", () => {
	it("judges the next slice instead of a new round, keeps a judged-and-refused domain seen, and forgets one it never judged", async () => {
		const round1 = Array.from({ length: 5 }, (_, i) =>
			goodResult(`cand${i}.com`),
		);
		const { calls, result } = run(1, [round1, [goodResult("final.com")]], {
			rejectsByCall: [[0, 1], []],
		});

		const outcome = await result;

		expect(outcome.rounds).toBe(1);
		expect(calls).toHaveLength(1);
		expect(outcome.companies[0]?.domain).toBe("cand2.com");
		expect(outcome.seenDomains).toEqual(
			expect.arrayContaining(["cand0.com", "cand1.com"]),
		);
		expect(outcome.seenDomains).not.toContain("cand4.com");
	});

	it("judges at most three slices in one round, however many candidates remain", async () => {
		const round1 = Array.from({ length: 30 }, (_, i) =>
			goodResult(`cand${i}.com`),
		);
		const refuseAll = [0, 1, 2, 3, 4, 5];
		const { search } = scriptedSearch([round1, []]);
		const { synthesize } = scriptedSynthesize();
		let judgeCalls = 0;
		const judge = scriptedJudge([refuseAll, refuseAll, refuseAll, refuseAll]);

		const outcome = await findCompanies(
			icp,
			3,
			testOptions(),
			testDeps({
				recentDomains: async () => [],
				synthesize,
				search,
				gate,
				judge: async (requirements, rows, env, evidence) => {
					judgeCalls += 1;
					return judge(requirements, rows, env, evidence);
				},
			}),
		);

		expect(judgeCalls).toBe(3);
		expect(outcome.companies).toHaveLength(0);
	});
});

describe("findCompanies — the plan's country bound filters the records", () => {
	it("refuses a company headquartered outside the plan's countries", async () => {
		const { result } = run(
			5,
			[
				[
					goodResult("abroad.com", { country: "Germany" }),
					goodResult("home.com", { country: "United States" }),
				],
			],
			{ planOverrides: { countries: ["United States"] } },
		);

		const outcome = await result;

		expect(outcome.companies.map((c) => c.domain)).toEqual(["home.com"]);
	});
});
