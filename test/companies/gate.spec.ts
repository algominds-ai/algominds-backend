import { describe, expect, it } from "vitest";
import {
	excludedDomains,
	seedExcludedDomains,
} from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { gate } from "@/core/companies/gate";

function companyRow(overrides: Partial<CompanyRow> = {}): CompanyRow {
	return {
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		record: null,
		description: null,
		...overrides,
	};
}

describe("gate — required fields", () => {
	it("keeps a row with every required field present, drops one missing any of them", () => {
		const rows = [
			companyRow(),
			companyRow({ name: null }),
			companyRow({ domain: null }),
		];

		const result = gate(rows, { seenDomains: new Set() });

		expect(result.kept).toEqual([rows[0]]);
		expect(result.rejects).toEqual([
			{ index: 1, reason: "missing-required" },
			{ index: 2, reason: "missing-required" },
		]);
	});
});

describe("gate — dedupe", () => {
	it("rejects a domain already seen, after normalization, and keeps one no earlier round returned", () => {
		const rows = [
			companyRow({ domain: "https://www.Acme.com/pricing" }),
			companyRow({ domain: "https://fresh.com" }),
		];

		const result = gate(rows, {
			seenDomains: new Set(["acme.com"]),
		});

		expect(result.kept).toEqual([rows[1]]);
		expect(result.rejects).toEqual([{ index: 0, reason: "already-seen" }]);
	});
});

describe("gate — no judgement of fit", () => {
	it("keeps a row whatever its description or vendor record say about fit", () => {
		const query = "US B2B software companies with a small team";
		const rows = [
			companyRow({ description: query }),
			companyRow({ record: null }),
			companyRow({ domain: "low-score.com" }),
		];

		const result = gate(rows, {
			seenDomains: new Set(),
		});

		expect(result.kept).toEqual(rows);
	});
});

describe("gate — safety", () => {
	it("does not throw when a row has no matching search result at all", () => {
		const rows = [companyRow(), companyRow({ domain: "second.com" })];

		const result = gate(rows, { seenDomains: new Set() });

		expect(result.kept).toHaveLength(2);
	});

	it("returns kept rows in input order and never mutates the input rows", () => {
		const rows = [
			companyRow({ domain: "a.com" }),
			companyRow({ domain: "seen.com" }),
			companyRow({ domain: "b.com" }),
		];
		const snapshot = structuredClone(rows);

		const result = gate(rows, {
			seenDomains: new Set(["seen.com"]),
		});

		expect(result.kept.map((row) => row.domain)).toEqual(["a.com", "b.com"]);
		expect(rows).toEqual(snapshot);
	});
});

describe("gate — a profile page is not the company's own site", () => {
	it("rejects a social, directory, library, or link-in-bio host, however cased or prefixed", () => {
		const badDomains = [
			"linkedin.com",
			"WWW.Crunchbase.com",
			"linktr.ee",
			"exa.ai",
		];
		const rows = badDomains.map((domain) => companyRow({ domain }));

		const result = gate(rows, { seenDomains: new Set() });

		expect(result.kept).toEqual([]);
		expect(result.rejects).toEqual(
			badDomains.map((_domain, index) => ({
				index,
				reason: "not-a-company-domain",
			})),
		);
	});

	it("keeps a real company domain that merely contains a host name", () => {
		const rows = [companyRow({ domain: "github-metrics.io" })];

		const result = gate(rows, { seenDomains: new Set() });

		expect(result.kept).toEqual(rows);
	});
});

describe("gate — a directory host never re-poisons the next round's search", () => {
	it("never sends a directory host as an excluded domain", () => {
		const seen = new Set(["real.com", "exa.ai", "linkedin.com"]);

		const excluded = excludedDomains([], seen);

		expect(excluded).toContain("real.com");
		expect(excluded).not.toContain("exa.ai");
		expect(excluded).not.toContain("linkedin.com");
	});
});

describe("domains a round tells the vendor not to return", () => {
	it("keeps the list inside the most the vendor accepts", () => {
		const seen = new Set(
			Array.from({ length: 1500 }, (_, i) => `seen-${i}.com`),
		);

		expect(excludedDomains(["caller.com"], seen)).toHaveLength(1200);
	});

	it("keeps the full persisted set at the deterministic gate after provider capping", () => {
		const seen = new Set(
			Array.from({ length: 1500 }, (_, i) => `seen-${i}.com`),
		);
		const candidate = companyRow({ domain: "seen-1499.com" });

		const result = gate([candidate], { seenDomains: seen });

		expect(result.kept).toEqual([]);
		expect(result.rejects[0]?.reason).toBe("already-seen");
	});
});

describe("a run never prospects for the seller it prospects on behalf of", () => {
	it("excludes the seller's own site from the first round, and only the caller's list with no seller", () => {
		const seller = {
			domain: "https://www.form3.tech/about",
			customers: ["Klarna"],
			description: "payment infrastructure for banks",
			sourceUrls: [],
		};

		expect([...seedExcludedDomains(["acme.com"], seller)].sort()).toEqual([
			"acme.com",
			"form3.tech",
		]);
		expect([
			...seedExcludedDomains(["acme.com"], {
				domain: null,
				description: "",
				customers: [],
				sourceUrls: [],
			}),
		]).toEqual(["acme.com"]);
	});
});
