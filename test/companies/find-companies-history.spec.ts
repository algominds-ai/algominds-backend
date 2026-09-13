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
				sourceUrl: null,
				date: null,
			})),
			reason: rejects.includes(index) ? "does not fit icp" : "fits icp",
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

describe("what one round hands the next", () => {
	it("keeps the caller's prior angle history in the single bounded round", async () => {
		const { inputs, result } = run(1, [[goodResult("right.com")]], {
			optionOverrides: { pastAngles: ["angle-from-an-earlier-round"] },
		});

		await result;

		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.pastAngles).toEqual(["angle-from-an-earlier-round"]);
	});

	it("carries an angle a caller already used, so a second call does not repeat it", async () => {
		const { inputs, result } = run(1, [[goodResult("a.com")]], {
			optionOverrides: { pastAngles: ["angle-from-an-earlier-round"] },
		});

		await result;

		expect(inputs[0]?.pastAngles).toEqual(["angle-from-an-earlier-round"]);
	});
});

describe("domains a round tells the vendor not to return", () => {
	it("names every earlier round's domains, and the domains already seen before the run started", async () => {
		const { calls, result } = run(1, [[goodResult("first.com")]]);
		await result;
		expect(calls).toHaveLength(1);
		expect(calls[0]?.excludeDomains).toContain("seller.example");

		const { calls: seededCalls, result: seededResult } = run(
			1,
			[[goodResult("new.com")]],
			{ seen: ["old.com"] },
		);
		await seededResult;
		expect(seededCalls[0]?.excludeDomains).toContain("old.com");
	});
});

describe("a company the caller already knows", () => {
	it("names the caller's own exclusion to the vendor, sends none when it named none, and never returns it anyway", async () => {
		const { calls: named, result: namedResult } = run(
			1,
			[[goodResult("other.com")]],
			{
				optionOverrides: { excludeDomains: ["leadiq.com"] },
			},
		);
		await namedResult;
		expect(named[0]?.excludeDomains).toEqual(["leadiq.com", "seller.example"]);

		const { calls: unnamed, result: unnamedResult } = run(1, [
			[goodResult("other.com")],
		]);
		await unnamedResult;
		expect(unnamed[0]?.excludeDomains).toEqual(["seller.example"]);

		const leaked = await run(
			2,
			[[goodResult("leadiq.com"), goodResult("other.com")]],
			{
				optionOverrides: { excludeDomains: ["leadiq.com"] },
				seen: ["leadiq.com"],
			},
		).result;
		expect(leaked.companies.map((row) => row.domain)).not.toContain(
			"leadiq.com",
		);
	});
});

describe("a one-round core call", () => {
	it("reports an empty result without retrying the vendor", async () => {
		const { calls, result } = run(1, [[]]);
		const outcome = await result;

		expect(calls).toHaveLength(1);
		expect(outcome.rounds).toBe(1);
		expect(outcome.status).toBe("empty");
	});
});
