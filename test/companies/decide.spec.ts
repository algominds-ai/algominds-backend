import { describe, expect, it } from "vitest";
import { config } from "@/config";
import { anglesForRound } from "@/core/companies";
import type { CompanyRow } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { decideRows, provenRate } from "@/core/companies/judge";
import { applyRecords } from "@/core/companies/record";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";

const recordRequirement: Requirement = {
	id: "r1",
	text: "the company is a bank",
	kind: "hard",
	proof: "record",
	windowDays: null,
};

const pageRequirement: Requirement = {
	id: "r2",
	text: "the company published an engineering page about its platform",
	kind: "hard",
	proof: "page",
	windowDays: 730,
};

const softRequirement: Requirement = {
	id: "r3",
	text: "the company posted a platform role recently",
	kind: "soft",
	proof: "page",
	windowDays: 30,
};

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		soft: [],
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
	it("asks for one angle when nothing needs a page, and bounds a page-gated round to the round's own cap", () => {
		expect(anglesForRound([recordRequirement], 20)).toBe(1);
		expect(anglesForRound([recordRequirement, pageRequirement], 3)).toBe(6);
		expect(anglesForRound([pageRequirement], 500)).toBe(
			config.companies.maxAnglesPerRound,
		);
	});
});

describe("the refusal policy differs by what can prove a requirement", () => {
	it("refuses a row whose strict record requirement the record does not establish, and keeps one whose plain record requirement is merely unproven", () => {
		const strict: Requirement = {
			...recordRequirement,
			id: "r9",
			strict: true,
		};
		const refused = decideRows({
			requirements: [strict],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r9", status: "unproven" }] })],
			excluded: new Set(),
		});
		expect(refused.stored).toHaveLength(0);
		expect(refused.rejects[0]?.reason).toContain(
			"the record does not establish r9",
		);

		const kept = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [
				verdict({
					statuses: [{ id: recordRequirement.id, status: "unproven" }],
				}),
			],
			excluded: new Set(),
		});
		expect(kept.stored).toHaveLength(1);
	});

	it("refuses a row that contradicts a hard requirement, whatever its proof", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r1", status: "contradicted" }] })],
			excluded: new Set(),
		});

		expect(decision.stored).toHaveLength(0);
		expect(decision.rejects[0]?.reason).toContain("contradicts r1");
	});

	it("keeps a row whose hard record requirement the record simply does not state", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r1", status: "unproven" }] })],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["a.com"]);
	});

	it("refuses a row whose hard page requirement no page proved, and stores one a cited page did", () => {
		const refused = decideRows({
			requirements: [pageRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r2", status: "unproven" }] })],
			excluded: new Set(),
		});
		expect(refused.stored).toHaveLength(0);
		expect(refused.rejects[0]?.reason).toContain("no page proved r2");

		const proved = decideRows({
			requirements: [pageRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r2", status: "proven" }] })],
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
						{ id: "r1", status: "proven" },
						{ id: "r3", status: "contradicted" },
					],
				}),
			],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["a.com"]);
	});

	it("reports the share of candidates whose page requirements were proved, for the next round to read", () => {
		const verdicts = [
			verdict({ index: 0, statuses: [{ id: "r2", status: "proven" }] }),
			verdict({ index: 1, statuses: [{ id: "r2", status: "unproven" }] }),
		];

		expect(provenRate([pageRequirement], verdicts)).toBe("1 of 2");
		expect(provenRate([recordRequirement], verdicts)).toBeNull();
	});
});

describe("one organisation is stored once, under one brand", () => {
	it("drops a row the judge marked as the same organisation as another, ignoring a collapse onto itself or outside the batch", () => {
		const collapsed = decideRows({
			requirements: [recordRequirement],
			rows: [row("home.barclays"), row("jobs.barclays")],
			verdicts: [
				verdict({ index: 0, statuses: [{ id: "r1", status: "proven" }] }),
				verdict({
					index: 1,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 0,
				}),
			],
			excluded: new Set(),
		});
		expect(collapsed.stored.map((kept) => kept.domain)).toEqual([
			"home.barclays",
		]);
		expect(collapsed.rejects[0]?.group).toBe(
			"one organisation under more than one brand",
		);

		const ignored = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com"), row("b.com")],
			verdicts: [
				verdict({
					index: 0,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 0,
				}),
				verdict({
					index: 1,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 9,
				}),
			],
			excluded: new Set(),
		});
		expect(ignored.stored.map((kept) => kept.domain)).toEqual([
			"a.com",
			"b.com",
		]);
	});
});

describe("a company this account already holds never comes back", () => {
	it("drops an excluded domain and the brand the judge collapses onto it", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("home.barclays"), row("jobs.barclays"), row("other.com")],
			verdicts: [
				verdict({ index: 0, statuses: [{ id: "r1", status: "proven" }] }),
				verdict({
					index: 1,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 0,
				}),
				verdict({ index: 2, statuses: [{ id: "r1", status: "proven" }] }),
			],
			excluded: new Set(["home.barclays"]),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["other.com"]);
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
