import { describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { decideRows } from "@/core/companies/judge";
import type { Requirement } from "@/core/requirements";

const recordRequirement: Requirement = {
	id: "r1",
	text: "the company is a bank",
	kind: "hard",
	proof: "record",
	windowDays: null,
};

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		reason: "a reason",
		sameOrganizationAs: null,
		...overrides,
	};
}

function provenVerdict(
	index: number,
	overrides: Partial<Verdict> = {},
): Verdict {
	return verdict({
		index,
		statuses: [{ id: "r1", status: "proven" }],
		...overrides,
	});
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

describe("one organisation is stored once, under one brand", () => {
	it("drops a row the judge marked as the same organisation as another, ignoring a collapse onto itself or outside the batch", () => {
		const collapsed = decideRows({
			requirements: [recordRequirement],
			rows: [row("home.barclays"), row("jobs.barclays")],
			verdicts: [provenVerdict(0), provenVerdict(1, { sameOrganizationAs: 0 })],
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
				provenVerdict(0, { sameOrganizationAs: 0 }),
				provenVerdict(1, { sameOrganizationAs: 9 }),
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
				provenVerdict(0),
				provenVerdict(1, { sameOrganizationAs: 0 }),
				provenVerdict(2),
			],
			excluded: new Set(["home.barclays"]),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["other.com"]);
	});
});
