import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { findCompanies } from "@/core/companies";
import { toExaSearchResult } from "@/core/companies/agent-search";
import type { RetrievedPage } from "@/core/companies/candidates";
import { gate } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import { ExaAgentCompanySchema } from "@/core/providers/exa/agent";
import type { ExaResult } from "@/core/providers/exa/search";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import duplicateCompanies from "../fixtures/exa-parallel-company-duplicates.json";
import { companyIdentityEvidence } from "../support/companies";
import { profileFixture, requirementFixture } from "../support/icp";

const icp: IcpDoc = profileFixture();
const requirement = requirementFixture("the company is a bank");

function plan(source: SearchPlan["source"] = "exa-search"): SearchPlan {
	return {
		query: "banks",
		angle: "banking",
		source,
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

function result(domain: string): ExaResult {
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

function options(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: testEnv,
		today: "2026-09-03",
		requirements: [requirement],
		...overrides,
	};
}

function verdict(index: number): Verdict {
	return {
		index,
		statuses: [
			{ id: "r1.a1.c1", status: "proven", sourceUrl: null, date: null },
		],
		reason: "fits",
	};
}

type Harness = {
	deps: FindCompaniesDeps;
	order: string[];
	backfilled: string[][];
	pages: RetrievedPage[];
};

function harness(
	route: "search" | "agent",
	pages: RetrievedPage[] = [],
): Harness {
	const order: string[] = [];
	const backfilled: string[][] = [];
	const deps: FindCompaniesDeps = {
		recentDomains: async () => [],
		synthesize: async () => ({
			route,
			plans: [plan(route === "agent" ? "exa-agent" : "exa-search")],
			ledger: new CostLedger(),
		}),
		search: async () => {
			order.push("search");
			return { requestId: "req-1", results: [result("bank.com")] };
		},
		agentRound: async () => {
			order.push("agent");
			return { requestId: "agent-1", results: [result("bank.com")] };
		},
		backfill: async (domains) => {
			backfilled.push([...domains]);
			return domains.map((domain) => ({ domain, record: null }));
		},
		retrieveEvidence: async ({ rows }) => {
			order.push("retrieveEvidence");
			return { evidenceByRow: companyIdentityEvidence(rows), pages };
		},
		gate,
		judge: async (_requirements, rows, _env, options) => {
			order.push("judge");
			expect(options?.evidenceByRow).toBeDefined();
			return {
				verdicts: rows.map((_row, index) => verdict(index)),
				ledger: new CostLedger(),
			};
		},
	};
	return { deps, order, backfilled, pages };
}

describe("round dependency flow", () => {
	it("judges the captured parallel-agent duplicates once while retaining every source", async () => {
		const h = harness("agent");
		const companies = duplicateCompanies.map((value) =>
			ExaAgentCompanySchema.parse(value),
		);
		h.deps.agentRound = async () =>
			toExaSearchResult("recorded-fanout", companies);
		const found = await findCompanies(icp, 3, options(), h.deps);
		expect(found.companies).toHaveLength(1);
		expect(h.backfilled).toEqual([["bloxley.com"]]);
		expect(found.captures["bloxley.com"]?.evidence).toEqual(
			companies.flatMap((company) => company.evidence),
		);
	});

	it("uses the agent route and backfills every named domain", async () => {
		const h = harness("agent");
		await findCompanies(icp, 1, options(), h.deps);
		expect(h.order).toEqual(["agent", "retrieveEvidence", "judge"]);
		expect(h.backfilled).toEqual([["bank.com"]]);
	});

	it("retrieves evidence once before judging and returns its pages", async () => {
		const pages = [
			{ domain: "bank.com", url: "https://bank.com/about", text: "Bank" },
		];
		const h = harness("search", pages);
		const output = await findCompanies(icp, 1, options(), h.deps);
		expect(h.order).toEqual(["search", "retrieveEvidence", "judge"]);
		expect(output.pages).toEqual(pages);
		expect(output.companies.map((company) => company.domain)).toEqual([
			"bank.com",
		]);
	});
});
