import { describe, expect, it } from "vitest";
import type { CompanyRow, SearchResult } from "../src/core/gate";
import { gate } from "../src/core/gate";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
	return new Date(Date.now() - days * DAY_MS).toISOString();
}

function companyRow(overrides: Partial<CompanyRow> = {}): CompanyRow {
	return {
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		evidenceUrl: "https://acme.com/hiring-announcement",
		signal: null,
		evidenceDate: null,
		...overrides,
	};
}

describe("gate — required fields and query echo", () => {
	it("keeps a row with every required field present", () => {
		const rows = [companyRow()];

		const result = gate(rows, [{}], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("drops a row missing a required field", () => {
		const rows = [companyRow({ evidenceUrl: null })];

		const result = gate(rows, [{}], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "missing-required" }]);
	});

	it("rejects a row whose field exactly echoes the search query", () => {
		const query =
			"fintech startup announced hiring its first head of go-to-market";
		const rows = [companyRow({ signal: `  ${query.toUpperCase()}  ` })];

		const result = gate(rows, [{}], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
			query,
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "echoes-query" }]);
	});

	it("keeps a row whose field merely shares a word with the query", () => {
		const query =
			"fintech startup announced hiring its first head of go-to-market";
		const rows = [
			companyRow({ signal: "Announced a new fintech partnership" }),
		];

		const result = gate(rows, [{}], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
			query,
		});

		expect(result.rejects).toEqual([]);
	});
});

describe("gate — score floor", () => {
	it("drops a row whose score is below the floor", () => {
		const rows = [companyRow()];

		const result = gate(rows, [{ score: 0.4 }], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "low-score" }]);
	});

	it("keeps a row whose score meets the floor", () => {
		const rows = [companyRow()];

		const result = gate(rows, [{ score: 0.5 }], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.rejects).toEqual([]);
	});

	it("skips the score check entirely when the vendor reports no score, never defaulting it", () => {
		const rows = [companyRow()];

		const result = gate(rows, [{}], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.9,
		});

		expect(result.rejects).toEqual([]);
	});

	it("checks each row's score against its own indexed result", () => {
		const rows = [
			companyRow({ domain: "acme.com" }),
			companyRow({ domain: "beta.com" }),
		];

		const result = gate(rows, [{ score: 0.9 }, { score: 0.1 }], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.kept).toEqual([rows[0]]);
		expect(result.rejects).toEqual([{ index: 1, reason: "low-score" }]);
	});
});

describe("gate — evidence freshness", () => {
	it("prefers the vendor's publishedDate over a model evidenceDate", () => {
		const rows = [companyRow({ evidenceDate: daysAgo(200) })];
		const results: SearchResult[] = [{ publishedDate: daysAgo(1) }];

		const result = gate(rows, results, {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.rejects).toEqual([]);
	});

	it("falls back to evidenceDate when publishedDate is absent", () => {
		const rows = [companyRow({ evidenceDate: daysAgo(200) })];

		const result = gate(rows, [{}], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "stale-evidence" }]);
	});

	it("rejects a publishedDate one day outside the freshness window", () => {
		const rows = [companyRow()];
		const results: SearchResult[] = [{ publishedDate: daysAgo(31) }];

		const result = gate(rows, results, {
			freshnessDays: 30,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "stale-evidence" }]);
	});

	it("rejects a malformed publishedDate instead of silently keeping it", () => {
		const rows = [companyRow()];
		const results: SearchResult[] = [{ publishedDate: "not-a-date" }];

		const result = gate(rows, results, {
			freshnessDays: 30,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "bad-date" }]);
	});

	it("skips the freshness check when neither date is present", () => {
		const rows = [companyRow()];

		const result = gate(rows, [{}], {
			freshnessDays: 30,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.rejects).toEqual([]);
	});
});

describe("gate — dedupe and safety", () => {
	it("rejects a domain already seen in an earlier round, after normalization", () => {
		const rows = [companyRow({ domain: "www.acme.com" })];

		const result = gate(rows, [{}], {
			freshnessDays: 90,
			seenDomains: new Set(["acme.com"]),
			scoreFloor: 0.5,
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "already-seen" }]);
	});

	it("does not throw when a row has no matching search result at all", () => {
		const rows = [companyRow()];

		const result = gate(rows, [], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("returns kept rows in input order and never mutates the input rows", () => {
		const original = [
			companyRow({ domain: "acme.com" }),
			companyRow({ domain: "beta.com" }),
		];
		const frozenRows = original.map((row) => Object.freeze(row));

		const result = gate(frozenRows, [{}, {}], {
			freshnessDays: 90,
			seenDomains: new Set(),
			scoreFloor: 0.5,
		});

		expect(result.kept.map((row) => row.domain)).toEqual([
			"acme.com",
			"beta.com",
		]);
		expect(frozenRows).toEqual(original);
	});
});
