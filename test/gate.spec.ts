import { describe, expect, it } from "vitest";
import type { Citation, CompanyRow, GroundingEntry } from "../src/core/gate";
import { gate, groundedFields, isGrounded, isRelevant } from "../src/core/gate";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
	return new Date(Date.now() - days * DAY_MS).toISOString();
}

function companyRow(overrides: Partial<CompanyRow> = {}): CompanyRow {
	return {
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		sourceUrl: null,
		signal: null,
		evidenceDate: null,
		...overrides,
	};
}

function citation(url: string): Citation {
	return { url };
}

function groundingEntry(field: string, citations: Citation[]): GroundingEntry {
	return { field, citations };
}

function fieldPath(index: number, field: string): string {
	return `structured.companies[${index}].${field}`;
}

function requiredGrounding(index: number): GroundingEntry[] {
	return [
		groundingEntry(fieldPath(index, "name"), []),
		groundingEntry(fieldPath(index, "domain"), []),
	];
}

describe("gate — grounding presence", () => {
	it("keeps a row and nulls an optional field that has no matching grounding entry", () => {
		const rows = [companyRow({ linkedinUrl: "https://linkedin.com/in/jane" })];
		const grounding = requiredGrounding(0);

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept[0]?.linkedinUrl).toBeNull();
	});

	it("drops a row when a required field has no matching grounding entry", () => {
		const rows = [companyRow()];
		const grounding = [groundingEntry(fieldPath(0, "name"), [])];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([
			{ index: 0, reason: "ungrounded-required" },
		]);
	});

	it("grounds a field by its exact row index, never by field name alone", () => {
		const rows = [
			companyRow({ linkedinUrl: "https://linkedin.com/in/first" }),
			companyRow({
				domain: "beta.com",
				linkedinUrl: "https://linkedin.com/in/second",
			}),
		];
		const grounding = [
			...requiredGrounding(0),
			...requiredGrounding(1),
			groundingEntry(fieldPath(0, "linkedinUrl"), [
				citation("https://linkedin.com/in/first"),
			]),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept[0]?.linkedinUrl).toBe("https://linkedin.com/in/first");
		expect(result.kept[1]?.linkedinUrl).toBeNull();
	});
});

describe("gate — domain relevance", () => {
	it("nulls a URL field whose only citation points at a different registrable domain", () => {
		const rows = [companyRow({ linkedinUrl: "https://linkedin.com/in/jane" })];
		const grounding = [
			...requiredGrounding(0),
			groundingEntry(fieldPath(0, "linkedinUrl"), [
				citation("https://someblog.com/post"),
			]),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept[0]?.linkedinUrl).toBeNull();
	});

	it("keeps a URL field whose citation shares its domain under a different subdomain", () => {
		const rows = [companyRow({ linkedinUrl: "https://linkedin.com/in/jane" })];
		const grounding = [
			...requiredGrounding(0),
			groundingEntry(fieldPath(0, "linkedinUrl"), [
				citation("https://www.linkedin.com/in/jane"),
			]),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept[0]?.linkedinUrl).toBe("https://linkedin.com/in/jane");
	});

	it("keeps a non-URL field on grounding presence alone, regardless of citation domain", () => {
		const rows = [companyRow({ signal: "Announced a GTM hire" })];
		const grounding = [
			...requiredGrounding(0),
			groundingEntry(fieldPath(0, "signal"), [
				citation("https://unrelated-source.example/post"),
			]),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept[0]?.signal).toBe("Announced a GTM hire");
	});

	it("treats a field value that fails to parse as a URL as non-URL, never as a failed domain check", () => {
		const rows = [companyRow({ linkedinUrl: "jane-doe" })];
		const grounding = [
			...requiredGrounding(0),
			groundingEntry(fieldPath(0, "linkedinUrl"), [
				citation("https://unrelated-source.example/post"),
			]),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept[0]?.linkedinUrl).toBe("jane-doe");
	});
});

describe("gate — evidence freshness", () => {
	it("keeps evidence one day inside the freshness window", () => {
		const rows = [companyRow({ evidenceDate: daysAgo(29) })];
		const grounding = [
			...requiredGrounding(0),
			groundingEntry(fieldPath(0, "evidenceDate"), []),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 30,
			seenDomains: new Set(),
		});

		expect(result.rejects).toEqual([]);
		expect(result.kept[0]?.evidenceDate).toBe(rows[0]?.evidenceDate);
	});

	it("rejects evidence one day outside the freshness window", () => {
		const rows = [companyRow({ evidenceDate: daysAgo(31) })];
		const grounding = [
			...requiredGrounding(0),
			groundingEntry(fieldPath(0, "evidenceDate"), []),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 30,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "stale-evidence" }]);
	});

	it("rejects a malformed evidence date instead of silently keeping it", () => {
		const rows = [companyRow({ evidenceDate: "not-a-date" })];
		const grounding = [
			...requiredGrounding(0),
			groundingEntry(fieldPath(0, "evidenceDate"), []),
		];

		const result = gate(rows, grounding, {
			freshnessDays: 30,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "bad-date" }]);
	});
});

describe("gate — dedupe and safety", () => {
	it("rejects a domain already seen in an earlier round, after normalization", () => {
		const rows = [companyRow({ domain: "www.acme.com" })];
		const grounding = requiredGrounding(0);

		const result = gate(rows, grounding, {
			freshnessDays: 90,
			seenDomains: new Set(["acme.com"]),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([{ index: 0, reason: "already-seen" }]);
	});

	it("does not throw on empty grounding, and drops every row missing a required field", () => {
		const rows = [companyRow({ linkedinUrl: "https://linkedin.com/in/jane" })];

		const result = gate(rows, [], {
			freshnessDays: 90,
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual([
			{ index: 0, reason: "ungrounded-required" },
		]);
	});

	it("returns kept rows in input order and never mutates the input rows", () => {
		const original = [
			companyRow({ domain: "acme.com" }),
			companyRow({ domain: "beta.com" }),
		];
		const frozenRows = original.map((row) => Object.freeze(row));
		const grounding = [...requiredGrounding(0), ...requiredGrounding(1)];

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

describe("groundedFields", () => {
	it("merges citations from repeated grounding entries at the same field path", () => {
		const grounding = [
			groundingEntry(fieldPath(0, "sourceUrl"), [
				citation("https://a.example/1"),
			]),
			groundingEntry(fieldPath(0, "sourceUrl"), [
				citation("https://a.example/2"),
			]),
		];

		const lookup = groundedFields(grounding);

		expect(lookup.get(fieldPath(0, "sourceUrl"))).toEqual([
			citation("https://a.example/1"),
			citation("https://a.example/2"),
		]);
	});
});

describe("isGrounded", () => {
	it("matches only the exact indexed field path", () => {
		const lookup = groundedFields([
			groundingEntry(fieldPath(0, "sourceUrl"), []),
		]);

		expect(isGrounded(lookup, 0, "sourceUrl")).toEqual([]);
		expect(isGrounded(lookup, 1, "sourceUrl")).toBeUndefined();
	});
});

describe("isRelevant", () => {
	it("passes any non-URL value without inspecting citations", () => {
		expect(isRelevant([], "just plain text")).toBe(true);
	});
});
