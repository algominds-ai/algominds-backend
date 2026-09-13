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
import { companyIdentityEvidence } from "../support/companies";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture(
	{},
	"fintech companies at seed stage in San Francisco with a small team",
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
			route: planOverrides.source === "exa-agent" ? "agent" : "search",
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
		const ledger = new CostLedger();
		ledger.reported("reasoning-model", "judge", 0.002);
		const verdicts: Verdict[] = rows.map((_row, index) => ({
			index,
			statuses: requiredConditionRefs(requirements).map((req) => ({
				id: req.id,
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

describe("findCompanies — the three terminal states", () => {
	it("keeps a duplicate-only response recoverable for a later angle", async () => {
		const { calls, result } = run(
			5,
			[
				[
					goodResult("seen.com"),
					goodResult("seen.com", { name: "Seen Again" }),
				],
			],
			{ seen: ["seen.com"] },
		);

		const outcome = await result;

		expect(calls).toHaveLength(1);
		expect(outcome.status).toBe("short");
		expect(outcome.companies).toHaveLength(0);
	});
});

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
