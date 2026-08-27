import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FALLBACK,
	MODELS_IN_USE,
	modelRate,
	RATES,
	rateFor,
} from "../src/core/rates";

const MODELS_RESPONSE = {
	data: [
		{
			id: "anthropic/claude-sonnet-4.5",
			pricing: { prompt: "0.000004", completion: "0.00002" },
		},
		{
			id: "some/unrelated-model",
			pricing: { prompt: "0.0000001", completion: "0.0000002" },
		},
	],
};

describe("rates", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns the pinned fallback when the price fetch fails, and leaves the memo empty for the next call", async () => {
		globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 }));

		const pricing = await modelRate("anthropic/claude-sonnet-4.5");

		expect(pricing).toEqual(FALLBACK["anthropic/claude-sonnet-4.5"]);
	});

	it("fetches once and memoizes across many concurrent calls, requesting edge caching", async () => {
		const fetchSpy = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json(MODELS_RESPONSE),
		);
		globalThis.fetch = fetchSpy;

		const calls = await Promise.all(
			Array.from({ length: 10 }, () =>
				modelRate("anthropic/claude-sonnet-4.5"),
			),
		);

		for (const pricing of calls) {
			expect(pricing).toEqual({ prompt: 0.000004, completion: 0.00002 });
		}
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const call = fetchSpy.mock.calls[0];
		expect(call?.[0]).toBe("https://openrouter.ai/api/v1/models");
		expect(call?.[1]?.cf).toEqual({ cacheTtl: 86400, cacheEverything: true });
	});

	it("drops a model outside its known set even when the upstream list still carries it", async () => {
		await expect(modelRate("some/unrelated-model")).rejects.toThrow(
			/no price known/,
		);
	});

	it("parses decimal-string prices into numbers, never leaving a string rate at a call site", async () => {
		const pricing = await modelRate("anthropic/claude-sonnet-4.5");

		expect(typeof pricing.prompt).toBe("number");
		expect(typeof pricing.completion).toBe("number");
	});

	it("keeps a pinned fallback for every model it can serve", () => {
		for (const id of MODELS_IN_USE) {
			expect(FALLBACK[id]).toBeDefined();
		}
	});

	it("reads the static rate table for Apollo and BrightData", () => {
		expect(rateFor("apollo", "credits")).toBe(RATES.apollo?.credits);
		expect(rateFor("brightdata", "records")).toBe(RATES.brightdata?.records);
	});

	it("returns undefined for a provider or unit with no configured rate", () => {
		expect(rateFor("apollo", "records")).toBeUndefined();
		expect(rateFor("unknown-vendor", "calls")).toBeUndefined();
	});

	it("resolves a model's tokens_in/tokens_out rate only after it has been fetched", async () => {
		globalThis.fetch = vi.fn(async () => Response.json(MODELS_RESPONSE));

		expect(rateFor("openai/gpt-4.1-mini", "tokens_in")).toBeUndefined();

		const pricing = await modelRate("openai/gpt-4.1-mini");

		expect(rateFor("openai/gpt-4.1-mini", "tokens_in")).toBe(pricing.prompt);
		expect(rateFor("openai/gpt-4.1-mini", "tokens_out")).toBe(
			pricing.completion,
		);
	});
});
