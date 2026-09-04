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
import type { IcpDoc, SearchPlan, SynthesizeInput } from "@/core/synthesize";

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

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

function entitylessResult(id: number): ExaResult {
	return {
		id: null,
		url: `https://example.com/missing-${id}`,
		title: `NoEntity${id}`,
		summary: null,
		company: null,
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
		requirements: [
			{
				id: "r1",
				text: "the company fits the profile",
				kind: "hard",
				proof: "record",
				windowDays: null,
			},
		],
		...overrides,
	};
}

function testPlan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "fintech companies",
		angle: "angle-1",
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
			route: planOverrides.source === "exa-agent" ? "agent" : "search",
			plans: [
				testPlan({
					query: `${input.icp.description} round-${inputs.length}`,
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
		const verdicts: Verdict[] = rows.map((_row, index) => ({
			index,
			statuses: requirements
				.filter((req) => req.kind === "hard")
				.map((req) => ({
					id: req.id,
					status: rejects.includes(index) ? "contradicted" : "proven",
				})),
			soft: [],
			reason: rejects.includes(index) ? "does not fit icp" : "fits icp",
			sameOrganizationAs: null,
		}));
		return { verdicts, ledger };
	};
}

function recordingRecentDomains(domains: string[] = []) {
	const calls: Array<{ organizationId: string; days: number }> = [];
	const recentDomains: FindCompaniesDeps["recentDomains"] = async (
		_env,
		organizationId,
		days,
	) => {
		calls.push({ organizationId, days });
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
	const { search, calls } = scriptedSearch(rounds);
	const { synthesize, inputs } = scriptedSynthesize(planOverrides);
	const { recentDomains } = recordingRecentDomains(seen);
	return {
		calls,
		inputs,
		result: findCompanies(
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
		),
	};
}

describe("findCompanies — a rejected row never counts", () => {
	it("never returns a result with no company record, even when it would have met the count", async () => {
		const { result } = run(2, [
			[goodResult("keep.com"), entitylessResult(1)],
			[],
		]);

		const outcome = await result;

		expect(outcome.companies.map((c) => c.domain)).toEqual(["keep.com"]);
		expect(
			outcome.rejects.some(
				(r) =>
					r.stage === "filter" &&
					r.reason === "no company record in the result",
			),
		).toBe(true);
	});
});

describe("findCompanies — the plan's numeric and country bounds filter the records", () => {
	it("refuses a company outside a bound the plan sets, per figure, keeping one the profile never bounded", async () => {
		const cases: Array<{
			bound: Partial<SearchPlan>;
			bad: ExaResult;
			good: ExaResult;
			reason: string;
		}> = [
			{
				bound: { maxWorkforce: 20 },
				bad: goodResult("big.com", { workforceTotal: 400 }),
				good: goodResult("small.com", { workforceTotal: 6 }),
				reason: "headcount 400 above the limit of 20",
			},
			{
				bound: { minFoundedYear: 2020 },
				bad: goodResult("old.com", { foundedYear: 2005 }),
				good: goodResult("new.com", { foundedYear: null }),
				reason: "founding year 2005 below the floor of 2020",
			},
			{
				bound: { maxRevenueAnnual: 10_000_000 },
				bad: goodResult("richco.com", { revenueAnnual: 90_000_000 }),
				good: goodResult("modest.com", { revenueAnnual: null }),
				reason: "annual revenue 90000000 above the limit of 10000000",
			},
			{
				bound: { minFundingTotal: 1_000_000 },
				bad: goodResult("bootstrapped.com", { fundingTotal: 50_000 }),
				good: goodResult("funded.com", { fundingTotal: 0 }),
				reason: "funding raised 50000 below the floor of 1000000",
			},
		];

		for (const { bound, bad, good, reason } of cases) {
			const outcome = await run(5, [[bad, good]], { planOverrides: bound })
				.result;
			expect(outcome.companies.map((c) => c.domain)).not.toContain(bad.url);
			expect(outcome.rejects.some((r) => r.reason === reason)).toBe(true);
		}
	});

	it("refuses a company headquartered outside the plan's countries", async () => {
		const outcome = await run(
			5,
			[
				[
					goodResult("abroad.com", { country: "Germany" }),
					goodResult("home.com", { country: "United States" }),
				],
			],
			{ planOverrides: { countries: ["United States"] } },
		).result;

		expect(outcome.companies.map((c) => c.domain)).toEqual(["home.com"]);
	});
});
