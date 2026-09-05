import { describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";

describe("CostLedger.reported", () => {
	it("maps a detail breakdown straight through, one line per key, or a flat figure under the provider when none is given", () => {
		const detailed = new CostLedger();
		detailed.reported("exa", "agent-run", 1.02, {
			agentCompute: 0.94,
			search: 0.04,
			fiber: 0.04,
		});
		const flat = new CostLedger();
		flat.reported("exa", "agent-run", 0.5);

		expect(detailed.byProvider()).toEqual({
			agentCompute: 0.94,
			search: 0.04,
			fiber: 0.04,
		});
		expect(flat.byProvider()).toEqual({ exa: 0.5 });
	});
});

describe("CostLedger.metered", () => {
	it("prices units at the configured rate, summing separate pools for the same provider", () => {
		const ledger = new CostLedger();

		ledger.metered("findymail", "find-email", 12, "credits");
		ledger.metered("findymail", "verify-email", 5, "verifier_credits");

		expect(ledger.byProvider().findymail).toBeCloseTo(12 * 0.01 + 5 * 0.01, 10);
	});

	it("throws at once for an unknown provider or unit rather than recording a silent zero", () => {
		const ledger = new CostLedger();

		expect(() => ledger.metered("clay", "enrich", 1, "credits")).toThrow();
		expect(() => ledger.metered("findymail", "op", 1, "records")).toThrow();
	});
});

describe("CostLedger totals", () => {
	it("total() equals the exact sum of byProvider(), and is zero, not undefined, with no entries", () => {
		const empty = new CostLedger();
		const ledger = new CostLedger();
		ledger.reported("exa", "agent-run", 0.5);
		ledger.reported("fiber", "connect", 0.25);
		ledger.reported("similarweb", "connect", 1.25);
		const sumOfByProvider = Object.values(ledger.byProvider()).reduce(
			(a, b) => a + b,
			0,
		);

		expect(empty.total()).toBe(0);
		expect(empty.byProvider()).toEqual({});
		expect(ledger.total()).toBe(sumOfByProvider);
		expect(ledger.total()).toBe(2);
	});

	it("toJSON returns the total, byProvider, and entries together", () => {
		const ledger = new CostLedger();
		ledger.reported("exa", "agent-run", 0.5);

		expect(ledger.toJSON()).toEqual({
			total: 0.5,
			byProvider: { exa: 0.5 },
			entries: [{ provider: "exa", op: "agent-run", dollars: 0.5 }],
		});
	});
});

describe("CostLedger.merge", () => {
	it("concatenates entries and sums totals exactly, so a workflow can just add ledgers", () => {
		const a = new CostLedger();
		a.reported("exa", "agent-run", 1.0);
		const b = new CostLedger();
		b.reported("apollo", "bulk_match", 2.5);

		const merged = CostLedger.merge(a, b);

		expect(merged.total()).toBe(a.total() + b.total());
		expect(merged.toJSON().entries).toEqual([
			...a.toJSON().entries,
			...b.toJSON().entries,
		]);
	});
});
