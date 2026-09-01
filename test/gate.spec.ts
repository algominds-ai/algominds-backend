import { describe, expect, it } from "vitest";
import {
	seedExcludedDomains,
	staleRejectReason,
} from "../src/core/companies/candidates";
import type { CompanyRow } from "../src/core/companies/gate";
import { gate } from "../src/core/companies/gate";

function companyRow(overrides: Partial<CompanyRow> = {}): CompanyRow {
	return {
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		evidenceUrl: "https://acme.com/",
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: null,
		evidenceDate: null,
		...overrides,
	};
}

describe("gate — required fields", () => {
	it("keeps a row with every required field present", () => {
		const rows = [companyRow()];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("drops a row missing a required field", () => {
		const rows = [companyRow({ evidenceUrl: null })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "missing-required" }]);
	});

	it("drops a row with no domain, because the dedupe read needs one", () => {
		const rows = [companyRow({ domain: null })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.rejects).toEqual([{ index: 0, reason: "missing-required" }]);
	});
});

describe("gate — dedupe", () => {
	it("rejects a domain already seen in an earlier round, after normalization", () => {
		const rows = [companyRow({ domain: "https://www.Acme.com/pricing" })];

		const result = gate(rows, [{}], { seenDomains: new Set(["acme.com"]) });

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "already-seen" }]);
	});

	it("keeps a domain that no earlier round returned", () => {
		const rows = [companyRow({ domain: "https://fresh.com" })];

		const result = gate(rows, [{}], { seenDomains: new Set(["acme.com"]) });

		expect(result.kept).toEqual(rows);
		expect(result.rejects).toEqual([]);
	});
});

describe("gate — no judgement of fit", () => {
	it("keeps a row whose signal repeats the search query, leaving fit to the judge", () => {
		const query = "US B2B software companies with a small team";
		const rows = [companyRow({ signal: query })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.kept).toEqual(rows);
	});

	it("keeps a row with an old evidence date, because a company record's date says nothing about fit", () => {
		const rows = [companyRow({ evidenceDate: "2019-01-01T00:00:00.000Z" })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.kept).toEqual(rows);
	});

	it("keeps a row whose vendor score is low, because the score is not a fit measure", () => {
		const rows = [companyRow()];

		const result = gate(rows, [{ score: 0.01 }], { seenDomains: new Set() });

		expect(result.kept).toEqual(rows);
	});
});

describe("gate — safety", () => {
	it("does not throw when a row has no matching search result at all", () => {
		const rows = [companyRow(), companyRow({ domain: "second.com" })];

		const result = gate(rows, [], { seenDomains: new Set() });

		expect(result.kept).toHaveLength(2);
	});

	it("returns kept rows in input order and never mutates the input rows", () => {
		const rows = [
			companyRow({ domain: "a.com" }),
			companyRow({ domain: "seen.com" }),
			companyRow({ domain: "b.com" }),
		];
		const snapshot = structuredClone(rows);

		const result = gate(rows, [{}, {}, {}], {
			seenDomains: new Set(["seen.com"]),
		});

		expect(result.kept.map((row) => row.domain)).toEqual(["a.com", "b.com"]);
		expect(rows).toEqual(snapshot);
	});
});

describe("gate — a profile page is not the company's own site", () => {
	it("rejects a row whose domain is a social or directory host", () => {
		const rows = [companyRow({ domain: "linkedin.com" })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([
			{ index: 0, reason: "not-a-company-domain" },
		]);
	});

	it("rejects it however the vendor cased or prefixed it", () => {
		const rows = [companyRow({ domain: "WWW.Crunchbase.com" })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.rejects[0]?.reason).toBe("not-a-company-domain");
	});

	it("rejects a link-in-bio page standing in for a company site", () => {
		const rows = [companyRow({ domain: "linktr.ee" })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.rejects[0]?.reason).toBe("not-a-company-domain");
	});

	it("keeps a real company domain that merely contains a host name", () => {
		const rows = [companyRow({ domain: "github-metrics.io" })];

		const result = gate(rows, [{}], { seenDomains: new Set() });

		expect(result.kept).toEqual(rows);
	});
});

describe("a date the code cannot read is not a date it can trust", () => {
	const TODAY = "2026-08-30";

	it("rejects an unparseable date, passes a missing one to the judge, and does the arithmetic otherwise", () => {
		expect(staleRejectReason("not-a-date", 30, TODAY)).toBe(
			"the evidence date is not a date",
		);
		expect(staleRejectReason(null, 30, TODAY)).toBeNull();
		expect(staleRejectReason("2026-08-20", 30, TODAY)).toBeNull();
		expect(staleRejectReason("2025-08-20", 30, TODAY)).toContain("days old");
	});
});

describe("a run never prospects for the seller it prospects on behalf of", () => {
	const seller = {
		domain: "https://www.form3.tech/about",
		customers: ["Klarna"],
		competitorTest: "A competitor sells payment infrastructure to banks.",
	};

	it("excludes the seller's own site from the first round, whichever source it uses", () => {
		expect([...seedExcludedDomains(["acme.com"], seller)].sort()).toEqual([
			"acme.com",
			"form3.tech",
		]);
	});

	it("excludes only the caller's list when the profile names no seller", () => {
		expect([...seedExcludedDomains(["acme.com"], null)]).toEqual(["acme.com"]);
	});
});
