import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import type { CompanyRow } from "@/core/companies/gate";
import { gate } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import type { ProvingHit } from "@/core/companies/proof";
import { CostLedger } from "@/core/cost";
import type { ExaResult } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import { conditionRefs } from "@/core/requirements";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture();
const recordRequirement = requirementFixture("the company is a bank");

function datedRequirement(text: string, amount = 30): Requirement {
	return {
		kind: "required",
		anyOf: [
			{
				allOf: [
					{
						text,
						window: {
							amount,
							unit: "days",
							appliesTo: "publication",
							direction: "past",
						},
						sourceRule: "company domain",
					},
				],
			},
		],
	};
}

const pageRequirement = datedRequirement(
	"the company published an engineering page about its platform",
);

const pageRequirement2 = datedRequirement(
	"the company published a security compliance page",
);
const pageId =
	conditionRefs([recordRequirement, pageRequirement])[1]?.id ?? "r2.a1.c1";
const pageId2 =
	conditionRefs([pageRequirement, pageRequirement2])[1]?.id ?? "r2.a1.c1";
const standalonePageId = conditionRefs([pageRequirement])[0]?.id ?? "r1.a1.c1";
function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		reason: "a reason",
		sameOrganizationAs: null,
		...overrides,
	};
}
function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
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
		...overrides,
	};
}

function exaResult(domain: string, workforce: number | null): ExaResult {
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
			workforceTotal: workforce,
			city: null,
			country: "United Kingdom",
			revenueAnnual: null,
			fundingTotal: null,
		},
	};
}

function statusFor(
	ref: ReturnType<typeof conditionRefs>[number],
	index: number,
	evidenceByRow: ReadonlyMap<number, ReadonlyMap<string, unknown>> | undefined,
): "proven" | "unproven" {
	if (ref.condition.window === null && ref.condition.sourceRule === null) {
		return "proven";
	}
	return evidenceByRow?.get(index)?.has(ref.id) ? "proven" : "unproven";
}

function options(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: testEnv,
		today: "2026-09-03",
		requirements: [recordRequirement],
		maxRounds: 1,
		...overrides,
	};
}

type RoundScript = {
	route: "search" | "agent";
	requirements: readonly Requirement[];
	results: ExaResult[];
	hits?: Record<string, ProvingHit>;
	verdicts?: (rows: readonly CompanyRow[]) => Verdict[];
};

function spyingDeps(script: RoundScript) {
	const order: string[] = [];
	const backfilled: Array<readonly string[]> = [];
	const deps: FindCompaniesDeps = {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: script.route,
			plans: [
				plan({ source: script.route === "agent" ? "exa-agent" : "exa-search" }),
			],
			ledger: new CostLedger(),
		}),
		search: async () => {
			order.push("search");
			return { requestId: "req-1", results: script.results };
		},
		agentRound: async (_plans, _excludeDomains) => {
			order.push("agent");
			return { requestId: "agent-1", results: script.results };
		},
		backfill: async (domains) => {
			backfilled.push(domains);
			return domains.map((domain) => ({ domain, record: null }));
		},
		prove: async (rows) => {
			order.push("prove");
			return rows.map((candidate, index) => ({
				index,
				hit: script.hits?.[candidate.domain ?? ""] ?? null,
			}));
		},
		homepages: async () => {
			order.push("homepages");
			return [];
		},
		gate,
		judge: async (requirements, rows, _env, options) => {
			order.push("judge");
			const refs = conditionRefs(requirements);
			return {
				verdicts: script.verdicts
					? script.verdicts(rows)
					: rows.map((_row, index) =>
							verdict({
								index,
								statuses: refs.map((ref) => ({
									id: ref.id,
									status: statusFor(ref, index, options?.evidenceByRow),
									quote: "",
								})),
							}),
						),
				ledger: new CostLedger(),
			};
		},
	};
	return { deps, order, backfilled };
}

describe("the route a round runs on comes from its requirements", () => {
	it("sends an agent round to the fan-out and backfills every record it named", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).toContain("agent");
		expect(spy.order).not.toContain("search");
		expect(spy.backfilled[0]).toEqual(["bank.com"]);
	});
});

function hitFor(requirementId: string): ProvingHit {
	return requirementId === pageId
		? {
				url: "https://bank.com/engineering",
				quote: "we run our own platform",
				publishedDate: "2026-01-01",
				text: "we run our own platform",
			}
		: {
				url: "https://bank.com/security",
				quote: "SOC 2 type II certified",
				publishedDate: "2026-01-01",
				text: "SOC 2 type II certified",
			};
}

describe("proving runs before the judge, and every hard page requirement gets its own proof", () => {
	it("proves every candidate of a search round, hands the judge the proved page, and keeps the page retrieved", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
			hits: {
				"bank.com": {
					url: "https://bank.com/engineering",
					quote: "we run our own platform",
					publishedDate: "2026-01-01",
					text: "the whole page text",
				},
			},
		});

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).toEqual([
			"search",
			"homepages",
			"judge",
			"prove",
			"judge",
		]);
		expect(result.pages).toEqual([
			{
				domain: "bank.com",
				url: "https://bank.com/engineering",
				text: "the whole page text",
			},
		]);
		expect(result.captures["bank.com"]?.result.evidenceCheck).toBe("found");
	});

	it("proves each hard page requirement separately, giving the judge every page found", async () => {
		const proveCalls: string[] = [];
		const spy = spyingDeps({
			route: "search",
			requirements: [pageRequirement, pageRequirement2],
			results: [exaResult("bank.com", 900)],
		});
		const deps: FindCompaniesDeps = {
			...spy.deps,
			prove: async (rows, demand) => {
				proveCalls.push(demand.requirement.id);
				const hit = hitFor(demand.requirement.id);
				return rows.map((_candidate, index) => ({ index, hit }));
			},
		};

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [pageRequirement, pageRequirement2] }),
			deps,
		);

		expect(proveCalls.sort()).toEqual([standalonePageId, pageId2]);
		expect(result.pages.map((page) => page.url).sort()).toEqual([
			"https://bank.com/engineering",
			"https://bank.com/security",
		]);
	});

	it("never proves on an agent round, because the agent already cited its page", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).not.toContain("prove");
	});
});
