import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import type {
	FindCompaniesDeps,
	FindCompaniesOptions,
	FindCompaniesResult,
} from "../src/core/companies";
import { findCompanies } from "../src/core/companies";
import { toExaSearchResult } from "../src/core/companies/agent-search";
import type {
	CompanyCapture,
	CompanyMatch,
} from "../src/core/companies/candidates";
import {
	excludedDomains,
	groupRejectReasons,
	toCompanyData,
} from "../src/core/companies/candidates";
import type { CompanyRow } from "../src/core/companies/gate";
import { gate } from "../src/core/companies/gate";
import type { Verdict } from "../src/core/companies/judge";
import { CostLedger } from "../src/core/cost";
import type { ExaAgentCompany } from "../src/core/providers/exa/agent";
import type {
	CompanyEntity,
	ExaResult,
	ExaSearchRequest,
} from "../src/core/providers/exa/search";
import type {
	IcpDoc,
	SearchPlan,
	SynthesizeInput,
} from "../src/core/synthesize";
import { finalStatus } from "../src/workflows/find-companies";

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

function entity(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
	return {
		name: "Example",
		description: "a small software company",
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

function testOptions(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return { icpId: "icp-1", env: testEnv, today: "2026-08-30", ...overrides };
}

function testPlan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "fintech companies",
		angle: "angle-1",
		recency: null,
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
			plan: {
				query: `${input.icp.description} round-${inputs.length}`,
				angle: `angle-${inputs.length}`,
				recency: null,
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
				...planOverrides,
			},
			ledger,
		};
	};
	return { synthesize, inputs };
}

function scriptedJudge(rejectsByCall: number[][]): FindCompaniesDeps["judge"] {
	let call = 0;
	return async (_icp, rows) => {
		const rejects = rejectsByCall[call] ?? [];
		call += 1;
		const ledger = new CostLedger();
		ledger.reported("reasoning-model", "judge", 0.002);
		const verdicts: Verdict[] = rows.map((_row, index) => ({
			index,
			keep: !rejects.includes(index),
			reason: rejects.includes(index) ? "does not fit icp" : "fits icp",
		}));
		return { verdicts, ledger };
	};
}

function recordingRecentDomains(domains: string[] = []) {
	const calls: Array<{ icpId: string; days: number }> = [];
	const recentDomains: FindCompaniesDeps["recentDomains"] = async (
		_env,
		icpId,
		days,
	) => {
		calls.push({ icpId, days });
		return domains;
	};
	return { recentDomains, calls };
}

describe("findCompanies — the three terminal states", () => {
	it("fills to the requested count across two rounds once the gate and judge have trimmed round one", async () => {
		const good = Array.from({ length: 8 }, (_, i) =>
			goodResult(`good${i}.com`),
		);
		const bad = Array.from({ length: 6 }, (_, i) => entitylessResult(i));
		const more = Array.from({ length: 5 }, (_, i) =>
			goodResult(`more${i}.com`),
		);
		const { search, calls } = scriptedSearch([[...good, ...bad], more]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 10, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([[7], [3, 4]]),
		});

		expect(calls).toHaveLength(2);
		expect(result.status).toBe("complete");
		expect(result.rounds).toBe(2);
		expect(result.found).toBe(10);
		expect(result.companies).toHaveLength(10);
	});

	it("stops at round one, exhausted, without a second search call, when every row is already seen", async () => {
		const { search, calls } = scriptedSearch([
			[goodResult("seen.com"), goodResult("seen.com", { name: "Seen Again" })],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains(["seen.com"]);

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toHaveLength(1);
		expect(result.status).toBe("exhausted");
		expect(result.rounds).toBe(1);
		expect(result.companies).toHaveLength(0);
	});

	it("returns short with no throw when three rounds still fall short of the count", async () => {
		const { search, calls } = scriptedSearch([
			[goodResult("r1a.com"), goodResult("r1b.com")],
			[goodResult("r2a.com"), goodResult("r2b.com")],
			[goodResult("r3a.com"), goodResult("r3b.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 10, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toHaveLength(3);
		expect(result.status).toBe("short");
		expect(result.rounds).toBe(3);
		expect(result.companies).toHaveLength(6);
	});
});

describe("findCompanies — a rejected row never counts", () => {
	it("never returns a result with no company record, even when it would have met the count", async () => {
		const { search } = scriptedSearch([
			[goodResult("keep.com"), entitylessResult(1)],
			[],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 2, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies).toHaveLength(1);
		expect(result.companies[0]?.domain).toBe("keep.com");
		expect(result.companies.some((c) => c.name?.startsWith("NoEntity"))).toBe(
			false,
		);
		expect(
			result.rejects.some(
				(r) =>
					r.stage === "filter" &&
					r.reason === "no company record in the result",
			),
		).toBe(true);
	});
});

describe("findCompanies — the plan's limits filter the records", () => {
	it("rejects a company whose headcount is above the plan's limit", async () => {
		const { search } = scriptedSearch([
			[
				goodResult("big.com", { workforceTotal: 400 }),
				goodResult("small.com", { workforceTotal: 6 }),
			],
		]);
		const { synthesize } = scriptedSynthesize({ maxWorkforce: 20 });
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies.some((c) => c.domain?.includes("big.com"))).toBe(
			false,
		);
		expect(result.companies.some((c) => c.domain?.includes("small.com"))).toBe(
			true,
		);
		expect(
			result.rejects.some(
				(r) => r.stage === "filter" && r.domain === "big.com",
			),
		).toBe(true);
	});

	it("rejects a company headquartered outside the plan's countries", async () => {
		const { search } = scriptedSearch([
			[
				goodResult("abroad.com", { country: "Germany" }),
				goodResult("home.com", { country: "United States" }),
			],
		]);
		const { synthesize } = scriptedSynthesize({
			countries: ["United States"],
		});
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies.some((c) => c.domain?.includes("abroad.com"))).toBe(
			false,
		);
		expect(result.companies.some((c) => c.domain?.includes("home.com"))).toBe(
			true,
		);
	});

	it("keeps a company whose record states no headcount, leaving the call to the judge", async () => {
		const { search } = scriptedSearch([
			[goodResult("unknown.com", { workforceTotal: null })],
		]);
		const { synthesize } = scriptedSynthesize({ maxWorkforce: 20 });
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies).toHaveLength(1);
	});
});

describe("findCompanies — round-to-round behaviour", () => {
	it("varies the query between rounds while keeping the ICP's scoping terms", async () => {
		const { search, calls } = scriptedSearch([
			[goodResult("v1.com"), entitylessResult(1)],
			[goodResult("v2.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(icp, 10, testOptions({ maxRounds: 2 }), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toHaveLength(2);
		const [first, second] = calls;
		expect(first?.query).not.toBe(second?.query);
		for (const call of calls) {
			expect(call.query).toContain("fintech");
			expect(call.query).toContain("seed");
			expect(call.query).toContain("San Francisco");
		}
	});

	it("reports costDollars as the merged total across every round and both model calls", async () => {
		const { search } = scriptedSearch([
			[goodResult("cost1.com")],
			[goodResult("cost2.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 2, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.rounds).toBe(2);
		expect(result.costDollars).toBeCloseTo(2 * (0.001 + 0.01 + 0.002), 9);
	});
});

describe("findCompanies — dependency wiring", () => {
	it("reads seen domains through the injected recentDomains dependency", async () => {
		const { search } = scriptedSearch([[goodResult("acme.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains, calls } = recordingRecentDomains(["known.com"]);

		await findCompanies(icp, 1, testOptions({ icpId: "icp-42" }), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toEqual([{ icpId: "icp-42", days: 90 }]);
	});

	it("runs as a plain function call, with no Hono context and no WorkflowStep", async () => {
		const { search } = scriptedSearch([[goodResult("plain.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.status).toBe("complete");
		expect(result.companies).toHaveLength(1);
	});
});

describe("findCompanies — capturing the vendor payload", () => {
	it("captures the full entity, including fields the row itself never reads", async () => {
		const richFields: Partial<CompanyEntity> = {
			workforceTotal: 42,
			foundedYear: 2018,
			revenueAnnual: 5_000_000,
			fundingTotal: 1_200_000,
		};
		const { search } = scriptedSearch([[goodResult("rich.com", richFields)]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.captures["rich.com"]?.entity).toEqual(
			entity({ name: "Company rich.com", ...richFields }),
		);
	});

	it("captures a result missing its score and published date with those fields null, not a thrown error", async () => {
		const { search } = scriptedSearch([[goodResult("noscore.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		const match: CompanyMatch | undefined =
			result.captures["noscore.com"]?.result;
		expect(match).toEqual({
			id: "https://exa.ai/library/organization/noscore.com",
			url: "https://noscore.com/",
			title: "Company noscore.com",
			signal: null,
			publishedDate: null,
			score: null,
		});
	});

	it("keeps the saved row to exactly the fields evidence reads, holding the vendor capture on the side", async () => {
		const { search } = scriptedSearch([[goodResult("shape.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(Object.keys(result.companies[0] ?? {}).sort()).toEqual([
			"description",
			"domain",
			"evidenceDate",
			"evidenceUrl",
			"linkedinUrl",
			"name",
			"signal",
		]);
	});
});

describe("findCompanies — captures across sources", () => {
	it("captures an agent-sourced company under the same shape as a search-sourced one", async () => {
		const agentCompany: ExaAgentCompany = {
			name: "Agent Co",
			website: "https://agentco.com",
			linkedinUrl: null,
			description: "found by the agent",
			foundedYear: 2020,
			workforceTotal: 12,
			city: "Austin",
			country: "United States",
			revenueAnnual: null,
			fundingTotal: null,
			signal: "opened a platform engineering role",
			evidenceUrl: "https://jobs.example.com/agent-co/platform",
			evidenceDate: "2026-08-12",
		};
		const agentSearchResult = toExaSearchResult("req-1", [agentCompany]);
		const { search } = scriptedSearch([agentSearchResult.results]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		const capture: CompanyCapture | undefined = result.captures["agentco.com"];
		expect(capture ? Object.keys(capture).sort() : []).toEqual([
			"entity",
			"result",
		]);
		expect(capture ? Object.keys(capture.entity).sort() : []).toEqual(
			Object.keys(entity()).sort(),
		);
		expect(capture ? Object.keys(capture.result).sort() : []).toEqual([
			"id",
			"publishedDate",
			"score",
			"signal",
			"title",
			"url",
		]);
	});
});

describe("toCompanyData", () => {
	it("names the provider that produced the capture", () => {
		const capture: CompanyCapture = {
			entity: entity(),
			result: {
				id: "https://exa.ai/library/organization/example",
				url: "https://example.com/",
				title: "Example",
				signal: null,
				publishedDate: null,
				score: null,
			},
		};

		expect(toCompanyData(capture, "exa-search")).toEqual({
			provider: "exa-search",
			entity: capture.entity,
			result: capture.result,
		});
		expect(toCompanyData(capture, "exa-agent").provider).toBe("exa-agent");
	});
});

const WORKFLOW_SCOPES = ["summary-size-test"];

async function terminateWorkflowRuns(): Promise<void> {
	for (const scope of WORKFLOW_SCOPES) {
		const instance = await testEnv.FIND_COMPANIES.get(scope).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
}

afterEach(terminateWorkflowRuns);

describe("the figures a profile can bound a company by", () => {
	it("refuses a company founded before the year the profile allows", async () => {
		const { search } = scriptedSearch([
			[goodResult("old.com", { foundedYear: 2005 })],
		]);
		const { synthesize } = scriptedSynthesize({ minFoundedYear: 2020 });
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies).toEqual([]);
		expect(result.rejects[0]?.reason).toBe(
			"founding year 2005 below the floor of 2020",
		);
	});

	it("refuses a company whose annual revenue is above the ceiling the profile allows", async () => {
		const { search } = scriptedSearch([
			[goodResult("big.com", { revenueAnnual: 90_000_000 })],
		]);
		const { synthesize } = scriptedSynthesize({
			maxRevenueAnnual: 10_000_000,
		});
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.rejects[0]?.reason).toBe(
			"annual revenue 90000000 above the limit of 10000000",
		);
	});

	it("refuses a company that raised less funding than the profile asks for", async () => {
		const { search } = scriptedSearch([
			[goodResult("bootstrapped.com", { fundingTotal: 50_000 })],
		]);
		const { synthesize } = scriptedSynthesize({ minFundingTotal: 1_000_000 });
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.rejects[0]?.reason).toBe(
			"funding raised 50000 below the floor of 1000000",
		);
	});

	it("keeps a company the profile set no bound for, whatever the figure says", async () => {
		const { search } = scriptedSearch([
			[goodResult("anything.com", { foundedYear: 1998, fundingTotal: 0 })],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies.map((row) => row.domain)).toEqual(["anything.com"]);
	});

	it("keeps a company whose figure the vendor did not report", async () => {
		const { search } = scriptedSearch([
			[goodResult("unknown.com", { foundedYear: null })],
		]);
		const { synthesize } = scriptedSynthesize({ minFoundedYear: 2020 });
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies.map((row) => row.domain)).toEqual(["unknown.com"]);
	});
});

describe("collapsing numeric reject reasons for the synthesizer's feedback", () => {
	it("collapses many companies below the same headcount floor into one counted line", async () => {
		const results = Array.from({ length: 5 }, (_, i) =>
			goodResult(`low${i}.com`, { workforceTotal: 10 + i }),
		);
		const { search } = scriptedSearch([results]);
		const { synthesize } = scriptedSynthesize({ minWorkforce: 20 });
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.rejects).toHaveLength(5);
		expect(result.rejects[0]?.reason).toBe(
			"headcount 10 below the floor of 20",
		);
		expect(groupRejectReasons(result.rejects)).toEqual([
			"5 companies had a headcount below the floor of 20",
		]);
	});

	it("passes a judge reject through the grouping untouched", async () => {
		const { search } = scriptedSearch([[goodResult("wrong.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([[0]]),
		});

		expect(result.rejects[0]).toEqual({
			domain: "wrong.com",
			reason: "does not fit icp",
			stage: "judge",
		});
		expect(groupRejectReasons(result.rejects)).toEqual(["does not fit icp"]);
	});
});

describe("what one round hands the next", () => {
	it("gives a later round every angle the earlier rounds already tried", async () => {
		const { search } = scriptedSearch([
			[goodResult("a.com")],
			[goodResult("b.com")],
			[goodResult("c.com")],
		]);
		const { synthesize, inputs } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(icp, 9, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(inputs).toHaveLength(3);
		expect(inputs[0]?.pastAngles).toEqual([]);
		expect(inputs[1]?.pastAngles).toEqual(["angle-1"]);
		expect(inputs[2]?.pastAngles).toEqual(["angle-1", "angle-2"]);
	});

	it("gives a later round the reasons the earlier round's companies were refused", async () => {
		const { search } = scriptedSearch([
			[goodResult("wrong.com")],
			[goodResult("right.com")],
		]);
		const { synthesize, inputs } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([[0]]),
		});

		expect(inputs[1]?.feedback.join(" ")).toContain("does not fit icp");
	});

	it("carries an angle a caller already used, so a second call does not repeat it", async () => {
		const { search } = scriptedSearch([[goodResult("a.com")]]);
		const { synthesize, inputs } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(
			icp,
			1,
			testOptions({ pastAngles: ["angle-from-an-earlier-round"] }),
			{ recentDomains, synthesize, search, gate, judge: scriptedJudge([]) },
		);

		expect(inputs[0]?.pastAngles).toEqual(["angle-from-an-earlier-round"]);
	});
});

describe("domains a round tells the vendor not to return", () => {
	it("names every company an earlier round already found", async () => {
		const { search, calls } = scriptedSearch([
			[goodResult("first.com")],
			[goodResult("second.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(icp, 2, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls[0]?.excludeDomains).toBeUndefined();
		expect(calls[1]?.excludeDomains).toContain("first.com");
	});

	it("names the domains already seen before the run started", async () => {
		const { search, calls } = scriptedSearch([[goodResult("new.com")]]);
		const { synthesize } = scriptedSynthesize();

		await findCompanies(icp, 1, testOptions(), {
			recentDomains: async () => ["old.com"],
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls[0]?.excludeDomains).toContain("old.com");
	});

	it("keeps the list inside the most the vendor accepts", () => {
		const seen = new Set(
			Array.from({ length: 1500 }, (_, i) => `seen-${i}.com`),
		);

		expect(excludedDomains(["caller.com"], seen)).toHaveLength(1200);
	});

	it("never repeats a domain the caller and the run both name", () => {
		const excluded = excludedDomains(["same.com"], new Set(["same.com"]));

		expect(excluded).toEqual(["same.com"]);
	});
});

describe("a company the caller already knows", () => {
	it("names it to the vendor so no result slot is spent on it", async () => {
		const { search, calls } = scriptedSearch([[goodResult("other.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(
			icp,
			1,
			testOptions({ excludeDomains: ["leadiq.com"] }),
			{ recentDomains, synthesize, search, gate, judge: scriptedJudge([]) },
		);

		expect(calls[0]?.excludeDomains).toEqual(["leadiq.com"]);
	});

	it("sends no exclusion at all when the caller named none", async () => {
		const { search, calls } = scriptedSearch([[goodResult("other.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls[0]?.excludeDomains).toBeUndefined();
	});

	it("never returns it, even when the vendor answers with it anyway", async () => {
		const { search } = scriptedSearch([
			[goodResult("leadiq.com"), goodResult("other.com")],
		]);
		const { synthesize } = scriptedSynthesize();

		const result = await findCompanies(
			icp,
			2,
			testOptions({ excludeDomains: ["leadiq.com"] }),
			{
				recentDomains: async () => ["leadiq.com"],
				synthesize,
				search,
				gate,
				judge: scriptedJudge([]),
			},
		);

		expect(result.companies.map((row) => row.domain)).not.toContain(
			"leadiq.com",
		);
	});
});

describe("a round the vendor answers with nothing", () => {
	it("searches again instead of stopping, and can still find a company", async () => {
		const { search } = scriptedSearch([[], [goodResult("late.com")]]);
		const { synthesize, inputs } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.rounds).toBe(2);
		expect(result.status).toBe("complete");
		expect(result.companies.map((row) => row.domain)).toEqual(["late.com"]);
		expect(inputs[1]?.feedback.join(" ")).toContain("too narrow");
	});

	it("reports empty, not exhausted, when every round matched nothing", async () => {
		const { search } = scriptedSearch([[], [], []]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.found).toBe(0);
		expect(result.status).toBe("empty");
		expect(result.status).not.toBe("exhausted");
	});

	it("still reports exhausted when the vendor answered but every company was already seen", async () => {
		const { search } = scriptedSearch([[goodResult("seen.com")]]);
		const { synthesize } = scriptedSynthesize();

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains: async () => ["seen.com"],
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.status).toBe("exhausted");
	});
});

describe("a round the filter refuses outright", () => {
	it("retries with the filter's own reasons as feedback, instead of stopping as exhausted", async () => {
		const { search } = scriptedSearch([
			[
				goodResult("big1.com", { workforceTotal: 400 }),
				goodResult("big2.com", { workforceTotal: 500 }),
			],
			[goodResult("small.com", { workforceTotal: 10 })],
		]);
		const { synthesize, inputs } = scriptedSynthesize({ maxWorkforce: 20 });
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.rounds).toBe(2);
		expect(result.status).toBe("complete");
		expect(result.companies.map((row) => row.domain)).toEqual(["small.com"]);
		expect(inputs[1]?.feedback.join(" ")).toContain(
			"headcount above the limit of 20",
		);
		expect(inputs[1]?.feedback.join(" ")).not.toContain(
			"matched no companies at all",
		);
	});
});

describe("what one round hands the next when the judge never saw every candidate", () => {
	it("excludes a domain that passed the filter but fell outside the judge's slice", async () => {
		const round1 = Array.from({ length: 5 }, (_, i) =>
			goodResult(`cand${i}.com`),
		);
		const { search, calls } = scriptedSearch([
			round1,
			[goodResult("final.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([[0, 1, 2], []]),
		});

		expect(result.rounds).toBe(2);
		expect(result.status).toBe("complete");
		expect(calls[1]?.excludeDomains).toContain("cand3.com");
		expect(calls[1]?.excludeDomains).toContain("cand4.com");
		expect(result.seenDomains).toEqual(
			expect.arrayContaining(["cand3.com", "cand4.com"]),
		);
	});
});

describe("FindCompaniesWorkflow: the summary output", () => {
	it("returns a bounded summary that does not grow with the number of companies found", async () => {
		const instanceId = "summary-size-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			const count = 50;
			const domains = Array.from({ length: count }, (_, i) => `co-${i}.com`);
			const companies: CompanyRow[] = domains.map((domain, i) => ({
				name: `Co ${i}`,
				domain,
				linkedinUrl: null,
				evidenceUrl: `https://${domain}`,
				description: null,
				signal: null,
				evidenceDate: null,
			}));
			const captures: Record<string, CompanyCapture> = Object.fromEntries(
				domains.map((domain) => [
					domain,
					{
						entity: entity({ name: domain }),
						result: {
							id: null,
							url: `https://${domain}/`,
							title: domain,
							signal: null,
							publishedDate: null,
							score: null,
						},
					},
				]),
			);
			const plan = testPlan();
			const roundResult: FindCompaniesResult = {
				companies,
				requested: count,
				found: count,
				rounds: 1,
				status: "complete",
				costDollars: 0.05,
				rejects: [],
				searches: [plan],
				captures,
				seenDomains: domains,
				feedback: [],
			};

			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, organizationId: "org-1" },
				);
				await m.mockStepResult({ name: "open-run" }, { id: instanceId });
				await m.mockStepResult({ name: "round_1" }, roundResult);
				await m.mockStepResult({ name: "save-companies" }, {});
				await m.mockStepResult({ name: "close-run" }, {});
			});

			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: "icp-summary-test", count },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				requested: count,
				found: count,
				rounds: 1,
				status: "complete",
				costDollars: 0.05,
				roundReports: [
					{
						round: 1,
						angle: plan.angle,
						query: plan.query,
						found: count,
						rejected: { filter: 0, gate: 0, judge: 0 },
					},
				],
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("FindCompaniesWorkflow: the per-run spend ceiling", () => {
	it("stops after the round that crossed the ceiling, reports capped, and still returns the rows it paid for", async () => {
		const instanceId = "spend-ceiling-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			const requested = 50;
			const companies: CompanyRow[] = ["paid-1.com", "paid-2.com"].map(
				(domain, i) => ({
					name: `Paid ${i}`,
					domain,
					linkedinUrl: null,
					evidenceUrl: `https://${domain}`,
					description: null,
					signal: null,
					evidenceDate: null,
				}),
			);
			const plan = testPlan();
			const overTheCeiling = config.spend.perRunDollars + 0.01;
			const roundOne: FindCompaniesResult = {
				companies,
				requested,
				found: companies.length,
				rounds: 1,
				status: "short",
				costDollars: overTheCeiling,
				rejects: [],
				searches: [plan],
				captures: {},
				seenDomains: companies.map((company) => company.domain ?? ""),
				feedback: [],
			};

			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, organizationId: "org-1" },
				);
				await m.mockStepResult({ name: "open-run" }, { id: instanceId });
				await m.mockStepResult({ name: "round_1" }, roundOne);
				await m.mockStepResult({ name: "save-companies" }, {});
				await m.mockStepResult({ name: "close-run" }, {});
			});

			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: "icp-spend-ceiling", count: requested },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toEqual({
				requested,
				found: companies.length,
				rounds: 1,
				status: "capped",
				costDollars: overTheCeiling,
				roundReports: [
					{
						round: 1,
						angle: plan.angle,
						query: plan.query,
						found: companies.length,
						rejected: { filter: 0, gate: 0, judge: 0 },
					},
				],
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("the status the workflow reports for the whole run", () => {
	it("never reports empty for a run that saved a company in an earlier round", () => {
		expect(finalStatus(2, 5, "empty")).toBe("short");
	});

	it("still reports empty when the run never saved a company at all", () => {
		expect(finalStatus(0, 5, "empty")).toBe("empty");
	});

	it("reports complete once the run saved as many companies as requested", () => {
		expect(finalStatus(5, 5, "empty")).toBe("complete");
	});
});
