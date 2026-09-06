import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { FindCompaniesDeps } from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type { ProvingHit } from "@/core/companies/proof";
import { proveAndJudge } from "@/core/companies/proving";
import { CostLedger } from "@/core/cost";
import type { Requirement } from "@/core/requirements";
import { profileFixture } from "../support/icp";

const pageRequirement: Requirement = {
	kind: "required",
	anyOf: [
		{
			allOf: [
				{
					text: "announced a priced round in the last ninety days",
					window: {
						amount: 90,
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

function agentRow(): CompanyRow {
	return {
		name: "Bank",
		domain: "bank.com",
		linkedinUrl: null,
		evidenceUrl: "https://bank.com/news",
		evidenceQuote: "we raised a series A",
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: null,
		evidenceDate: null,
	};
}

function capture(): CompanyCapture {
	return {
		entity: {
			name: "Bank",
			description: null,
			industry: null,
			foundedYear: null,
			workforceTotal: null,
			city: null,
			country: null,
			revenueAnnual: null,
			fundingTotal: null,
		},
		result: {
			id: null,
			url: "https://bank.com/news",
			title: "Bank",
			signal: null,
			quote: "we raised a series A",
			publisher: null,
			kind: null,
			publishedDate: null,
			score: null,
			evidenceCheck: "missing",
			fitReason: null,
		},
		raw: "{}",
		source: "exa-agent",
	};
}

const hit: ProvingHit = {
	url: "https://bank.com/blog/series-a",
	quote: "closed a series A",
	publishedDate: "2026-08-01",
	text: "closed a series A",
};

function deps(hits: ProvingHit | null): {
	deps: FindCompaniesDeps;
	judged: CompanyRow[][];
} {
	const judged: CompanyRow[][] = [];
	const unreachable = async () => {
		throw new Error("this stage must not run");
	};
	return {
		judged,
		deps: {
			recentDomains: unreachable,
			synthesize: unreachable,
			search: unreachable,
			agentRound: unreachable,
			backfill: unreachable,
			gate: () => ({ kept: [], rejects: [] }),
			prove: async (rows) => rows.map((_row, index) => ({ index, hit: hits })),
			homepages: async () => [],
			judge: async (_requirements, rows) => {
				judged.push([...rows]);
				return { verdicts: [], ledger: new CostLedger() };
			},
		},
	};
}

async function judgeAgentRow(hits: ProvingHit | null) {
	const captures = { "bank.com": capture() };
	const harness = deps(hits);
	await proveAndJudge({
		icp: profileFixture({ requirements: [pageRequirement] }),
		route: "agent",
		deps: harness.deps,
		requirements: [pageRequirement],
		checked: {
			kept: [agentRow()],
			pages: [],
			checks: { "bank.com": "missing" },
		},
		env: testEnv,
		ledger: new CostLedger(),
		captures,
		today: "2026-09-03",
	});
	return { judged: harness.judged, capture: captures["bank.com"] };
}

describe("an agent row's quote must be on the page it cites", () => {
	it("re-proves the row and the stored capture names the page the pass finds", async () => {
		const { judged, capture: stored } = await judgeAgentRow(hit);

		expect(judged[0]?.[0]?.evidenceUrl).toBe(hit.url);
		expect(stored?.result.url).toBe(hit.url);
		expect(stored?.result.quote).toBe(hit.quote);
		expect(stored?.result.evidenceCheck).toBe("found");
	});

	it("leaves the row with no evidence at all when no page proves the requirement", async () => {
		const { judged } = await judgeAgentRow(null);

		expect(judged[0]?.[0]?.evidenceUrl).toBeNull();
		expect(judged[0]?.[0]?.evidenceQuote).toBeNull();
	});
});
