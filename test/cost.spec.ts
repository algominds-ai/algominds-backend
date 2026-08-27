import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	CostLedger,
	customCostHeader,
	isGatewayCacheHit,
	isSpendLimitExceeded,
	recordModelCall,
	resolveModelId,
} from "../src/core/cost";
import { log } from "../src/core/log";
import { FALLBACK, modelRate } from "../src/core/rates";

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
	it("prices tokens_in and tokens_out at each class's own rate and sums them", () => {
		const ledger = new CostLedger();

		ledger.metered("apollo", "bulk_match", 12, "credits");
		ledger.metered("brightdata", "trigger", 5, "records");

		expect(ledger.byProvider().apollo).toBeCloseTo(12 * 0.01, 10);
		expect(ledger.byProvider().brightdata).toBeCloseTo(5 * 0.0025, 10);
	});

	it("throws at once for an unknown provider or unit rather than recording a silent zero", () => {
		const ledger = new CostLedger();

		expect(() => ledger.metered("clay", "enrich", 1, "credits")).toThrow();
		expect(() => ledger.metered("apollo", "op", 1, "calls")).toThrow();
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
	let originalFetch: typeof fetch;

	const PRICING_DISTINCT_FROM_FALLBACK = {
		prompt: "0.000005",
		completion: "0.000025",
	};

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () =>
			Response.json({
				data: [
					{
						id: "anthropic/claude-sonnet-4.5",
						pricing: PRICING_DISTINCT_FROM_FALLBACK,
					},
				],
			}),
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("meters at the pinned fallback rate when the OpenRouter fetch fails, and the ledger still totals correctly", async () => {
		globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 }));
		const ledger = new CostLedger();

		await recordModelCall(ledger, "synthesize", "anthropic/claude-sonnet-4.5", {
			headers: new Headers(),
			usage: { inputTokens: 12_000, outputTokens: 800 },
		});

		const fallback = FALLBACK["anthropic/claude-sonnet-4.5"];
		const expected =
			12_000 * (fallback?.prompt ?? 0) + 800 * (fallback?.completion ?? 0);
		expect(ledger.total()).toBeCloseTo(expected, 10);
	});

	it("records zero on a gateway cache hit, even though usage reports tokens", async () => {
		const ledger = new CostLedger();

		await recordModelCall(ledger, "synthesize", "anthropic/claude-sonnet-4.5", {
			headers: new Headers({ "cf-aig-cache-status": "HIT" }),
			usage: { inputTokens: 12_000, outputTokens: 800 },
		});

		expect(ledger.total()).toBe(0);
	});

	it("meters input and output tokens at the resolved model's rate when it is not a cache hit", async () => {
		const ledger = new CostLedger();

		await recordModelCall(ledger, "synthesize", "anthropic/claude-sonnet-4.5", {
			headers: new Headers(),
			usage: { inputTokens: 12_000, outputTokens: 800 },
		});

		const expected = 12_000 * 0.000005 + 800 * 0.000025;
		expect(ledger.total()).toBeCloseTo(expected, 10);
	});

	it("sends cf-aig-custom-cost built from the same rate the ledger used for the same call", async () => {
		const pricing = await modelRate("anthropic/claude-sonnet-4.5");
		const header = customCostHeader(pricing);

		expect(JSON.parse(header)).toEqual({
			per_token_in: pricing.prompt,
			per_token_out: pricing.completion,
		});
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
