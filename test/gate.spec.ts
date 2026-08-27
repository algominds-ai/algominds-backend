import { describe, expect, it } from "vitest";
import type { CompanyRow } from "../src/core/gate";
import { gate } from "../src/core/gate";

function companyRow(overrides: Partial<CompanyRow> = {}): CompanyRow {
	return {
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		evidenceUrl: "https://acme.com/",
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
