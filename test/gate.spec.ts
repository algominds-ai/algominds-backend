import { describe, expect, it } from "vitest";
import type {
	Citation,
	CompanyRow,
	Confidence,
	GroundingEntry,
} from "../src/core/gate";
import { gate, groundedRows } from "../src/core/gate";

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

function citation(url: string): Citation {
	return { url };
}

function rowGrounding(
	index: number,
	confidence: Confidence | null = "high",
): GroundingEntry {
	return {
		field: `structured.companies[${index}]`,
		citations: [citation("https://acme.com/hiring-announcement")],
		confidence,
	};
}

describe("gate — grounding presence", () => {
	it("keeps a row backed by a row-level grounding entry", () => {
		const rows = [companyRow()];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("drops a row whose index has no grounding entry", () => {
		const rows = [companyRow()];

		const result = gate(rows, [], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "ungrounded" }]);
	});

	it("grounds a row by its exact index, never by array position alone", () => {
		const rows = [
			companyRow({ domain: "acme.com" }),
			companyRow({ domain: "beta.com" }),
		];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([rows[0]]);
		expect(result.rejects).toEqual([{ index: 1, reason: "ungrounded" }]);
	});

	it("still resolves a documented field-suffixed path to its row index", () => {
		const rows = [companyRow()];
		const grounding: GroundingEntry[] = [
			{
				field: "structured.companies[0].evidenceUrl",
				citations: [citation("https://acme.com/hiring-announcement")],
				confidence: "high",
			},
		];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("drops a row missing a required field even when its row is grounded", () => {
		const rows = [companyRow({ evidenceUrl: null })];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "missing-required" }]);
	});
});

describe("gate — confidence floor", () => {
	it("drops a row grounded at low confidence under the default floor", () => {
		const rows = [companyRow()];

		const result = gate(rows, [rowGrounding(0, "low")], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "low-confidence" }]);
	});

	it("keeps medium and high confidence under the default floor", () => {
		const rows = [companyRow(), companyRow({ domain: "beta.com" })];
		const grounding = [rowGrounding(0, "medium"), rowGrounding(1, "high")];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("keeps low confidence once the floor is lowered to low", () => {
		const rows = [companyRow()];

		const result = gate(rows, [rowGrounding(0, "low")], {
			freshnessDays: 90,
			seenDomains: new Set(),
			confidenceFloor: "low",
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("drops a row with no confidence reported at all", () => {
		const rows = [companyRow()];

		const result = gate(rows, [rowGrounding(0, null)], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "low-confidence" }]);
	});
});

describe("gate — evidence freshness", () => {
	it("keeps evidence one day inside the freshness window", () => {
		const rows = [companyRow({ evidenceDate: daysAgo(29) })];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 30,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept).toEqual(rows);
	});

	it("rejects evidence one day outside the freshness window", () => {
		const rows = [companyRow({ evidenceDate: daysAgo(31) })];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 30,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "stale-evidence" }]);
	});

	it("rejects a malformed evidence date instead of silently keeping it", () => {
		const rows = [companyRow({ evidenceDate: "not-a-date" })];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 30,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "bad-date" }]);
	});

	it("skips the freshness check entirely when no evidence date is reported", () => {
		const rows = [companyRow({ evidenceDate: null })];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 30,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
	});
});

describe("gate — dedupe and safety", () => {
	it("rejects a domain already seen in an earlier round, after normalization", () => {
		const rows = [companyRow({ domain: "www.acme.com" })];

		const result = gate(rows, [rowGrounding(0)], {
			freshnessDays: 90,
			seenDomains: new Set(["acme.com"]),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "already-seen" }]);
	});

	it("does not throw on empty grounding, and drops every row", () => {
		const rows = [companyRow()];

		const result = gate(rows, [], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "ungrounded" }]);
	});

	it("returns kept rows in input order and never mutates the input rows", () => {
		const original = [
			companyRow({ domain: "acme.com" }),
			companyRow({ domain: "beta.com" }),
		];
		const frozenRows = original.map((row) => Object.freeze(row));
		const grounding = [rowGrounding(0), rowGrounding(1)];

		const result = gate(frozenRows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept.map((row) => row.domain)).toEqual([
			"acme.com",
			"beta.com",
		]);
		expect(frozenRows).toEqual(original);
	});
});

describe("groundedRows", () => {
	it("merges citations from repeated entries at the same row index", () => {
		const grounding: GroundingEntry[] = [
			{
				field: "structured.companies[0]",
				citations: [citation("https://a.example/1")],
				confidence: "medium",
			},
			{
				field: "structured.companies[0]",
				citations: [citation("https://a.example/2")],
				confidence: "high",
			},
		];

		const lookup = groundedRows(grounding);

		expect(lookup.get(0)).toEqual({
			citations: [
				citation("https://a.example/1"),
				citation("https://a.example/2"),
			],
			confidence: "high",
		});
	});

	it("resolves a field-suffixed path to the same row index as a bare one", () => {
		const lookup = groundedRows([
			{
				field: "structured.companies[2].sourceUrl",
				citations: [],
				confidence: "medium",
			},
		]);

		expect(lookup.get(2)).toEqual({ citations: [], confidence: "medium" });
	});

	it("ignores an entry whose field carries no row index", () => {
		const lookup = groundedRows([
			{ field: "structured.summary", citations: [], confidence: "high" },
		]);

		expect(lookup.size).toBe(0);
	});
});
