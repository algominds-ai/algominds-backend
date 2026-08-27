import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	CostLedger,
	isGatewayCacheHit,
	isSpendLimitExceeded,
	recordModelCall,
	resolveModelId,
} from "../src/core/cost";
import { log } from "../src/core/log";

describe("CostLedger.reported", () => {
	it("maps an Exa dataSources breakdown straight through, so fiber shows on its own line", () => {
		const ledger = new CostLedger();

		ledger.reported("exa", "agent-run", 1.02, {
			agentCompute: 0.94,
			search: 0.04,
			fiber: 0.04,
		});

		const byProvider = ledger.byProvider();
		expect(byProvider.fiber).toBe(0.04);
		expect(byProvider.agentCompute).toBe(0.94);
		expect(byProvider.search).toBe(0.04);
	});

	it("records a flat figure under the provider when no detail is given", () => {
		const ledger = new CostLedger();

		ledger.reported("exa", "agent-run", 0.5);

		expect(ledger.byProvider()).toEqual({ exa: 0.5 });
	});
});

describe("CostLedger.metered", () => {
	it("prices units at the configured rate for that provider and unit", () => {
		const ledger = new CostLedger();

		ledger.metered("findymail", "find-email", 12, "credits");

		expect(ledger.byProvider().findymail).toBeCloseTo(12 * 0.01, 10);
	});

	it("throws at once for an unknown provider or unit rather than recording a silent zero", () => {
		const ledger = new CostLedger();

		expect(() => ledger.metered("clay", "enrich", 1, "credits")).toThrow();
		expect(() => ledger.metered("findymail", "op", 1, "records")).toThrow();
	});
});

describe("CostLedger totals", () => {
	it("total() equals the exact sum of byProvider(), using amounts binary floating point adds exactly", () => {
		const ledger = new CostLedger();

		ledger.reported("exa", "agent-run", 0.5);
		ledger.reported("fiber", "connect", 0.25);
		ledger.reported("similarweb", "connect", 1.25);

		const sumOfByProvider = Object.values(ledger.byProvider()).reduce(
			(a, b) => a + b,
			0,
		);
		expect(ledger.total()).toBe(sumOfByProvider);
		expect(ledger.total()).toBe(2);
	});

	it("returns total: 0 for a ledger with no entries, never undefined", () => {
		const ledger = new CostLedger();

		expect(ledger.total()).toBe(0);
		expect(ledger.byProvider()).toEqual({});
	});

	it("toJSON returns { total, byProvider, entries }", () => {
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

describe("model-call resolution", () => {
	function headersWith(entries: Record<string, string>): Headers {
		return new Headers(entries);
	}

	it("prices the header's model over the configured id when the dynamic route falls back", () => {
		const id = resolveModelId(
			headersWith({ "cf-aig-model": "openai/gpt-4.1-mini" }),
			"anthropic/claude-sonnet-4.5",
			"anthropic/claude-sonnet-4.5",
		);
		expect(id).toBe("openai/gpt-4.1-mini");
	});

	it("falls back to response.modelId when the header is absent", () => {
		const id = resolveModelId(
			headersWith({}),
			"openai/gpt-4.1-mini",
			"anthropic/claude-sonnet-4.5",
		);
		expect(id).toBe("openai/gpt-4.1-mini");
	});

	it("falls back to the configured id and warns when both header and modelId are absent", () => {
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const id = resolveModelId(
			headersWith({}),
			undefined,
			"anthropic/claude-sonnet-4.5",
		);

		expect(id).toBe("anthropic/claude-sonnet-4.5");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});

	it("recognizes an HIT cf-aig-cache-status as a cache hit", () => {
		expect(
			isGatewayCacheHit(headersWith({ "cf-aig-cache-status": "HIT" })),
		).toBe(true);
		expect(
			isGatewayCacheHit(headersWith({ "cf-aig-cache-status": "MISS" })),
		).toBe(false);
		expect(isGatewayCacheHit(headersWith({}))).toBe(false);
	});
});

describe("recordModelCall", () => {
	it("records zero on a gateway cache hit, even though the gateway also reports a cost", () => {
		const ledger = new CostLedger();

		recordModelCall(ledger, "synthesize", "dynamic/reasoning", {
			headers: new Headers({ "cf-aig-cache-status": "HIT" }),
			usage: { cost: 1.78e-6 },
		});

		expect(ledger.total()).toBe(0);
	});

	it("reports the gateway's own dollar cost under the model it actually used", () => {
		const ledger = new CostLedger();

		recordModelCall(ledger, "synthesize", "dynamic/reasoning", {
			headers: new Headers({
				"cf-aig-cache-status": "MISS",
				"cf-aig-model": "deepseek/deepseek-v4-flash-0731",
			}),
			usage: { cost: 1.78e-6 },
		});

		expect(ledger.byProvider()["deepseek/deepseek-v4-flash-0731"]).toBeCloseTo(
			1.78e-6,
			12,
		);
	});
});

describe("isSpendLimitExceeded", () => {
	it("classifies a 429 carrying a spend-limit message as non-retryable", () => {
		expect(
			isSpendLimitExceeded(429, { error: { message: "spend limit exceeded" } }),
		).toBe(true);
	});

	it("does not classify an ordinary rate-limit 429 as a spend limit", () => {
		expect(
			isSpendLimitExceeded(429, { error: { message: "too many requests" } }),
		).toBe(false);
	});

	it("returns false for any non-429 status", () => {
		expect(
			isSpendLimitExceeded(500, { error: { message: "spend limit exceeded" } }),
		).toBe(false);
	});

	it("returns false when the body does not match the expected error envelope", () => {
		expect(isSpendLimitExceeded(429, { message: "spend limit exceeded" })).toBe(
			false,
		);
		expect(isSpendLimitExceeded(429, null)).toBe(false);
	});
});

const LoggedLineSchema = z.object({
	provider: z.string(),
	operation: z.string(),
	ms: z.number(),
	ok: z.boolean(),
	costDollars: z.number(),
	requestId: z.string().optional(),
});

function parseLoggedLine(call: unknown[] | undefined) {
	const raw = call?.[0];
	if (typeof raw !== "string") {
		throw new Error("expected console.log to receive a JSON string");
	}
	return LoggedLineSchema.parse(JSON.parse(raw));
}

describe("log", () => {
	it("emits one JSON line containing every field the caller passed", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		log({
			provider: "exa",
			operation: "agent-run",
			ms: 1200,
			ok: true,
			costDollars: 0.5,
			requestId: "req-1",
		});

		expect(logSpy).toHaveBeenCalledWith(
			JSON.stringify({
				provider: "exa",
				operation: "agent-run",
				ms: 1200,
				ok: true,
				costDollars: 0.5,
				requestId: "req-1",
			}),
		);
		logSpy.mockRestore();
	});

	it("still logs a failed call with ok: false, its requestId, and any cost the vendor charged", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		log({
			provider: "exa",
			operation: "agent-run",
			ms: 300,
			ok: false,
			costDollars: 0.02,
			requestId: "req-2",
		});

		const line = parseLoggedLine(logSpy.mock.calls[0]);
		expect(line.ok).toBe(false);
		expect(line.requestId).toBe("req-2");
		expect(line.costDollars).toBe(0.02);
		logSpy.mockRestore();
	});

	it("carries the Exa x-request-id on both a success and a failure", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		log({
			provider: "exa",
			operation: "agent-run",
			ms: 100,
			ok: true,
			costDollars: 0.5,
			requestId: "req-success",
		});
		log({
			provider: "exa",
			operation: "agent-run",
			ms: 100,
			ok: false,
			costDollars: 0,
			requestId: "req-failure",
		});

		const lines = logSpy.mock.calls.map(parseLoggedLine);
		expect(lines[0]?.requestId).toBe("req-success");
		expect(lines[1]?.requestId).toBe("req-failure");
		logSpy.mockRestore();
	});

	it("a provider that succeeds once and misses twice logs three lines, exactly two of them ok: false", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		log({
			provider: "apollo",
			operation: "bulk_match",
			ms: 50,
			ok: false,
			costDollars: 0,
		});
		log({
			provider: "apollo",
			operation: "bulk_match",
			ms: 50,
			ok: false,
			costDollars: 0,
		});
		log({
			provider: "apollo",
			operation: "bulk_match",
			ms: 80,
			ok: true,
			costDollars: 0.09,
		});

		const lines = logSpy.mock.calls.map(parseLoggedLine);
		const misses = lines.filter((line) => !line.ok);
		expect(lines).toHaveLength(3);
		expect(misses).toHaveLength(2);
		logSpy.mockRestore();
	});
});
