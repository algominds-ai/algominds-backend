import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { backfillRecords } from "../../src/core/companies/record";
import { CostLedger } from "../../src/core/cost";
import { exaContents } from "../../src/core/providers/exa/contents";
import type { ExaSearchRequest } from "../../src/core/providers/exa/search";
import { search } from "../../src/core/providers/exa/search";
import { RetryableProviderError } from "../../src/core/providers/waterfall";
import { fakeSecretEnv } from "../support/env";
import {
	jsonResponse,
	respondInSequence,
	respondOnce,
	stubSleep,
	throwsTimeout,
} from "../support/fetch";

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

type SuccessBodyOverrides = {
	requestId?: string;
	costDollars?: {
		total: number;
		search?: { keyword: number };
		summary?: number;
	};
	results?: Array<{
		url: string;
		title: string;
		publishedDate?: string;
		summary?: string;
	}>;
};

function successBody(overrides: SuccessBodyOverrides = {}) {
	return {
		requestId: "req-200",
		costDollars: { total: 0.01, search: { keyword: 0.007 }, summary: 0.003 },
		results: [
			{
				url: "https://linkedin.com/in/example",
				title: "Example Person",
				publishedDate: "2026-08-01",
			},
		],
		...overrides,
	};
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.unstubAllGlobals();
});

describe("search request shape", () => {
	it("sends the query with x-api-key and never a bearer token", async () => {
		const captured = respondOnce(jsonResponse(successBody()));
		globalThis.fetch = captured.fetch;

		await search({ query: "GTM leads" }, exaEnv(), new CostLedger());

		const headers = new Headers(captured.calls[0]?.init?.headers);
		expect(headers.get("x-api-key")).toBe("test-exa-key");
		expect(headers.get("authorization")).toBeNull();
	});

	it("rejects a malformed search request before any network call", async () => {
		const captured = respondOnce(jsonResponse(successBody({ results: [] })));
		globalThis.fetch = captured.fetch;
		const conflicting: ExaSearchRequest = {
			query: "seed stage fintech",
			category: "company",
			startPublishedDate: "2026-01-01",
		};
		const badCategory: ExaSearchRequest = JSON.parse(
			JSON.stringify({ query: "anything", category: "not-a-real-category" }),
		);

		let caught: unknown;
		try {
			await search(conflicting, exaEnv(), new CostLedger());
		} catch (error) {
			caught = error;
		}
		await expect(
			search(badCategory, exaEnv(), new CostLedger()),
		).rejects.toThrow();

		expect(caught).toBeInstanceOf(NonRetryableError);
		if (caught instanceof Error) {
			expect(caught.message).toContain("category");
			expect(caught.message).toContain("startPublishedDate");
		}
		expect(captured.calls).toHaveLength(0);
	});
});

describe("search failure mapping shared by every Exa endpoint", () => {
	it("raises RetryableProviderError after a second 429", async () => {
		const captured = respondInSequence([
			jsonResponse({ requestId: "req-429" }, 429),
			jsonResponse({ requestId: "req-429-again" }, 429),
		]);
		globalThis.fetch = captured.fetch;
		stubSleep();

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
		expect(captured.calls).toHaveLength(2);
	});

	it("raises NonRetryableError on a 400", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({ requestId: "req-400", message: "bad request" }, 400),
		).fetch;

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(NonRetryableError);
	});

	it("captures requestId on a 200", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse(successBody({ requestId: "req-ok-123" })),
		).fetch;

		const result = await search(
			{ query: "GTM leads" },
			exaEnv(),
			new CostLedger(),
		);

		expect(result.requestId).toBe("req-ok-123");
	});

	it("names the vendor's requestId in the thrown message on a 500", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({ requestId: "req-fail-500", message: "boom" }, 500),
		).fetch;

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(/req-fail-500/);
	});

	it("waits once for Retry-After then returns the retry's 200, with two fetches", async () => {
		const captured = respondInSequence([
			new Response(null, { status: 429, headers: { "retry-after": "2" } }),
			jsonResponse(successBody({ requestId: "req-after-retry" })),
		]);
		globalThis.fetch = captured.fetch;
		const sleeps = stubSleep();

		const result = await search(
			{ query: "GTM leads" },
			exaEnv(),
			new CostLedger(),
		);

		expect(captured.calls).toHaveLength(2);
		expect(sleeps.waits).toEqual([2000]);
		expect(result.requestId).toBe("req-after-retry");
	});

	it("caps a Retry-After above the configured maximum", async () => {
		globalThis.fetch = respondInSequence([
			new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
			jsonResponse(successBody()),
		]).fetch;
		const sleeps = stubSleep();

		await search({ query: "GTM leads" }, exaEnv(), new CostLedger());

		expect(sleeps.waits).toEqual([5000]);
	});

	it("times out a hung connection as retryable", async () => {
		globalThis.fetch = throwsTimeout();

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
	});

	it("raises NonRetryableError, not a raw Zod error, on a malformed 200 body, naming the requestId", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({
				requestId: "req-malformed",
				costDollars: { total: 0.01 },
				results: [{ url: "https://a.example" }],
			}),
		).fetch;

		let caught: unknown;
		try {
			await search({ query: "GTM leads" }, exaEnv(), new CostLedger());
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NonRetryableError);
		expect(caught).not.toBeInstanceOf(RetryableProviderError);
		if (caught instanceof Error) {
			expect(caught.message).toContain("req-malformed");
		}
	});
});

describe("search cost reporting", () => {
	it("reports costDollars into the ledger unchanged, including the summary component", async () => {
		globalThis.fetch = respondOnce(jsonResponse(successBody())).fetch;
		const ledger = new CostLedger();

		await search({ query: "GTM leads" }, exaEnv(), ledger);

		const byProvider = ledger.byProvider();
		expect(byProvider["search.keyword"]).toBe(0.007);
		expect(byProvider.summary).toBe(0.003);
		expect(ledger.total()).toBeCloseTo(0.01, 5);
	});
});

describe("search summary parsing", () => {
	it("yields a null summary for invalid JSON and parses valid JSON into an object", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse(
				successBody({
					results: [
						{ url: "https://a.example", title: "A", summary: "not json" },
						{
							url: "https://b.example",
							title: "B",
							summary: '{"fullName":"Max Freeman"}',
						},
					],
				}),
			),
		).fetch;

		const result = await search(
			{ query: "GTM leads" },
			exaEnv(),
			new CostLedger(),
		);

		expect(result.results).toHaveLength(2);
		expect(result.results[0]?.summary).toBeNull();
		expect(result.results[1]?.summary).toEqual({ fullName: "Max Freeman" });
	});
});

describe("company record backfill waits between concurrency slices", () => {
	it("waits one second between slices when more than one is needed, never when one suffices", async () => {
		globalThis.fetch = async () =>
			jsonResponse({
				requestId: "req-backfill",
				costDollars: { total: 0 },
				results: [],
			});
		const sleeps = stubSleep();
		const domains = Array.from(
			{ length: 7 },
			(_, index) => `company-${index}.com`,
		);

		await backfillRecords(domains, exaEnv(), new CostLedger());
		expect(sleeps.waits).toEqual([1000]);

		sleeps.waits.length = 0;
		await backfillRecords(["a.com", "b.com"], exaEnv(), new CostLedger());
		expect(sleeps.waits).toEqual([]);
	});
});

const ContentsRequestSchema = z.object({
	urls: z.array(z.string()),
	text: z.object({ maxCharacters: z.number() }),
});

describe("contents request shape", () => {
	it("sends urls and a top-level text.maxCharacters, with x-api-key and never a bearer token", async () => {
		const captured = respondOnce(
			jsonResponse({
				requestId: "req-contents-1",
				results: [{ url: "https://acme.example/team", text: "hello" }],
				statuses: [{ id: "https://acme.example/team", status: "success" }],
				costDollars: { total: 0.003 },
			}),
		);
		globalThis.fetch = captured.fetch;

		await exaContents(
			["https://acme.example/team"],
			exaEnv(),
			new CostLedger(),
		);

		expect(captured.calls[0]?.url).toBe("https://api.exa.ai/contents");
		const headers = new Headers(captured.calls[0]?.init?.headers);
		expect(headers.get("x-api-key")).toBe("test-exa-key");
		expect(headers.get("authorization")).toBeNull();
		const body = ContentsRequestSchema.parse(
			JSON.parse(String(captured.calls[0]?.init?.body)),
		);
		expect(body.urls).toEqual(["https://acme.example/team"]);
		expect(body.text.maxCharacters).toBeGreaterThan(0);
	});
});

describe("contents response shape and cost", () => {
	it("raises NonRetryableError on a malformed 200 body", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({ requestId: "req-bad", results: "nope" }),
		).fetch;

		await expect(
			exaContents(["https://acme.example/team"], exaEnv(), new CostLedger()),
		).rejects.toThrow(NonRetryableError);
	});

	it("banks costDollars.total into the ledger", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({
				requestId: "req-contents-2",
				results: [{ url: "https://acme.example/team", text: "hello" }],
				statuses: [{ id: "https://acme.example/team", status: "success" }],
				costDollars: { total: 0.003 },
			}),
		).fetch;
		const ledger = new CostLedger();

		await exaContents(["https://acme.example/team"], exaEnv(), ledger);

		expect(ledger.total()).toBeCloseTo(0.003, 5);
	});
});
