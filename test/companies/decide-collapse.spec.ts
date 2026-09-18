import { describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import { decideRows } from "@/core/companies/judge";
import { conditionRefs } from "@/core/requirements";
import { requirementFixture } from "../support/icp";

const recordRequirement = requirementFixture("the company is a bank");
const recordId = conditionRefs([recordRequirement])[0]?.id ?? "r1.a1.c1";

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		reason: "a reason",
		...overrides,
	};
}

function provenVerdict(
	index: number,
	overrides: Partial<Verdict> = {},
): Verdict {
	return verdict({
		index,
		statuses: [{ id: recordId, status: "proven", sourceUrl: null, date: null }],
		...overrides,
	});
}

function row(
	domain: string,
	linkedinUrl = `https://linkedin.com/company/${domain}`,
): CompanyRow {
	return {
		name: domain,
		domain,
		linkedinUrl,
		record: null,
		description: null,
	};
}

describe("provider identity deduplicates accepted companies", () => {
	it("keeps the first fit-positive row for one canonical provider LinkedIn identity", () => {
		const collapsed = decideRows({
			requirements: [recordRequirement],
			rows: [
				row("home.barclays", "https://linkedin.com/company/barclays"),
				row(
					"jobs.barclays",
					"https://uk.linkedin.com/company/barclays/?from=exa",
				),
			],
			verdicts: [provenVerdict(0), provenVerdict(1)],
			excluded: new Set(),
		});
		expect(collapsed.stored.map((kept) => kept.domain)).toEqual([
			"home.barclays",
		]);
		expect(collapsed.stored[0]?.linkedinUrl).toBe(
			"https://www.linkedin.com/company/barclays",
		);
		expect(collapsed.rejects[0]).toMatchObject({
			domain: "jobs.barclays",
			stage: "gate",
			group: "one company under more than one domain",
		});
	});

	it("keeps companies with different provider identities", () => {
		const distinct = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com"), row("b.com")],
			verdicts: [provenVerdict(0), provenVerdict(1)],
			excluded: new Set(),
		});
		expect(distinct.stored.map((kept) => kept.domain)).toEqual([
			"a.com",
			"b.com",
		]);
	});

	it.each([
		"unproven",
		"contradicted",
	] as const)("does not let an earlier %s row reserve the identity", (status) => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [
				row("old.bank", "https://linkedin.com/company/bank"),
				row("current.bank", "https://linkedin.com/company/bank"),
			],
			verdicts: [
				verdict({
					statuses: [{ id: recordId, status, sourceUrl: null, date: null }],
				}),
				provenVerdict(1),
			],
			excluded: new Set(),
		});
		expect(decision.stored.map((kept) => kept.domain)).toEqual([
			"current.bank",
		]);
		expect(decision.rejects[0]?.stage).toBe("judge");
	});
});

describe("a company this account already holds never comes back", () => {
	it("drops an excluded domain and its canonical identity even when that domain appears later", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [
				row("jobs.barclays", "https://linkedin.com/company/barclays"),
				row("home.barclays", "https://www.linkedin.com/company/barclays/"),
				row("other.com"),
			],
			verdicts: [provenVerdict(0), provenVerdict(2)],
			excluded: new Set(["home.barclays"]),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["other.com"]);
		expect(decision.rejects.map((rejected) => rejected.reason)).toEqual([
			"already found for this account",
			"already found for this account",
		]);
	});

	it("uses known excluded identities when the excluded domain was gated before judging", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [
				row("jobs.barclays", "https://linkedin.com/company/barclays"),
				row("other.com"),
			],
			verdicts: [provenVerdict(0), provenVerdict(1)],
			excluded: new Set(["home.barclays"]),
			excludedLinkedInUrls: new Set([
				"https://uk.linkedin.com/company/barclays/?from=exa",
			]),
		});
		expect(decision.stored.map((kept) => kept.domain)).toEqual(["other.com"]);
		expect(decision.rejects[0]).toMatchObject({
			domain: "jobs.barclays",
			stage: "gate",
			reason: "already found for this account",
		});
	});
});
