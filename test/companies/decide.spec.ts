import { describe, expect, it } from "vitest";
import { config } from "@/config";
import { anglesForRound } from "@/core/companies";
import type { CompanyRow } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { decideRows, provenRate } from "@/core/companies/judge";
import { applyRecords } from "@/core/companies/record";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import { conditionRefs } from "@/core/requirements";
import { requirementFixture } from "../support/icp";

const recordRequirement = requirementFixture("the company is a bank");
const recordId = conditionRefs([recordRequirement])[0]?.id ?? "r1.a1.c1";

const pageRequirement = {
	...requirementFixture(
		"the company published an engineering page about its platform",
	),
	anyOf: [
		{
			allOf: [
				{
					text: "the company published an engineering page about its platform",
					window: {
						amount: 730,
						unit: "days" as const,
						appliesTo: "publication" as const,
						direction: "past" as const,
					},
					sourceRule: null,
				},
			],
		},
	],
};
const pageId = conditionRefs([pageRequirement])[0]?.id ?? "r1.a1.c1";

const softRequirement = requirementFixture(
	"the company posted a platform role recently",
	"preferred",
);
const softId =
	conditionRefs([recordRequirement, softRequirement])[1]?.id ?? "r2.a1.c1";

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		reason: "a reason",
		sameOrganizationAs: null,
		...overrides,
	};
}

function row(domain: string): CompanyRow {
	return {
		name: domain,
		domain,
		linkedinUrl: null,
		evidenceUrl: `https://${domain}/`,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: null,
		evidenceDate: null,
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

describe("the route a round runs on comes from its requirements", () => {
	it("scales a search round's angles with the shortfall, and bounds a page-gated round to the round's own cap", () => {
		expect(anglesForRound([recordRequirement], 20)).toBe(2);
		expect(anglesForRound([recordRequirement], 3)).toBe(1);
		expect(anglesForRound([recordRequirement, pageRequirement], 3)).toBe(6);
		expect(anglesForRound([pageRequirement], 500)).toBe(
			config.companies.maxAnglesPerRound,
		);
		expect(anglesForRound([recordRequirement], 1000)).toBe(
			config.companies.maxAnglesPerRound,
		);
	});
});

describe("the refusal policy differs by what can prove a requirement", () => {
	it("refuses a row whose required condition the record does not establish", () => {
		const refused = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: recordId, status: "unproven" }] })],
			excluded: new Set(),
		});
		expect(refused.stored).toHaveLength(0);
		expect(refused.rejects[0]?.reason).toContain("required condition");
	});

	it("refuses a row that contradicts a hard requirement, whatever its proof, and falls back to a stand-in detail when its reason came back empty", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [
				verdict({
					statuses: [{ id: recordId, status: "contradicted" }],
				}),
			],
			excluded: new Set(),
		});

		expect(decision.stored).toHaveLength(0);
		expect(decision.rejects[0]?.reason).toContain("contradicts");

		const empty = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [
				verdict({
					statuses: [{ id: recordId, status: "contradicted" }],
					reason: "",
				}),
			],
			excluded: new Set(),
		});
		expect(empty.rejects[0]?.reason).toBe(
			"contradicts r1.a1.c1: the judge gave no reason",
		);
	});

	it("refuses a row whose required record condition is unproven", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: recordId, status: "unproven" }] })],
			excluded: new Set(),
		});

		expect(decision.stored).toHaveLength(0);
	});
});

describe("a hard page or soft requirement is judged on its own terms", () => {
	it("refuses a row whose hard page requirement no page proved, and stores one a cited page did", () => {
		const refused = decideRows({
			requirements: [pageRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: pageId, status: "unproven" }] })],
			excluded: new Set(),
		});
		expect(refused.stored).toHaveLength(0);
		expect(refused.rejects[0]?.reason).toContain("required condition");

		const proved = decideRows({
			requirements: [pageRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: pageId, status: "proven" }] })],
			excluded: new Set(),
		});
		expect(proved.stored.map((kept) => kept.domain)).toEqual(["a.com"]);
	});

	it("never gates on a soft requirement, however it came back", () => {
		const decision = decideRows({
			requirements: [recordRequirement, softRequirement],
			rows: [row("a.com")],
			verdicts: [
				verdict({
					statuses: [
						{ id: recordId, status: "proven" },
						{ id: softId, status: "contradicted" },
					],
				}),
			],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["a.com"]);
	});

	it("reports the share of candidates whose page requirements were proved, for the next round to read", () => {
		const verdicts = [
			verdict({
				index: 0,
				statuses: [{ id: pageId, status: "proven" }],
			}),
			verdict({
				index: 1,
				statuses: [{ id: pageId, status: "unproven" }],
			}),
		];

		expect(provenRate([pageRequirement], verdicts)).toBe("1 of 2");
		expect(provenRate([recordRequirement], verdicts)).toBeNull();
	});
});

function bankResult(overrides: Partial<CompanyEntity>): ExaResult {
	return {
		id: null,
		url: "https://saxo.com",
		title: "Saxo",
		summary: null,
		person: null,
		company: {
			name: "Saxo",
			description: "a bank",
			industry: "banking",
			foundedYear: null,
			workforceTotal: 2600,
			city: null,
			country: "Denmark",
			revenueAnnual: null,
			fundingTotal: null,
			...overrides,
		},
	};
}

describe("an agent-found company is bounded by the vendor's record, not its own claim", () => {
	it("prefers the vendor's figures, keeps the agent's where the vendor is silent, and applies only to the domain asked for", () => {
		const agentResult = bankResult({});
		const vendorResult = bankResult({
			name: "Saxo Bank",
			description: "the vendor's description",
			industry: null,
			foundedYear: 1992,
			workforceTotal: 1403,
			city: "Copenhagen",
		});

		const merged = applyRecords(
			[agentResult],
			[{ domain: "saxo.com", record: vendorResult }],
		);
		expect(merged[0]?.company?.workforceTotal).toBe(1403);
		expect(merged[0]?.company?.description).toBe("the vendor's description");
		expect(merged[0]?.company?.industry).toBe("banking");

		const unanswered = applyRecords([exaResult("real.com", 17)], []);
		expect(unanswered[0]?.company?.workforceTotal).toBe(17);
	});
});
