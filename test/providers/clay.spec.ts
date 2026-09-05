import { afterEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "../../src/core/cost";
import { canonicalPersonUrl, claySearch } from "../../src/core/providers/clay";
import { RetryableProviderError } from "../../src/core/providers/waterfall";
import searchPage from "../fixtures/clay-search.json";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, stubClaySequence, stubSleep } from "../support/fetch";

function clayEnv(): Env {
	return fakeSecretEnv({ CLAY_API_KEY: "test-clay-key" });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.unstubAllGlobals();
});

describe("canonical linkedin person url", () => {
	it("normalizes protocol, www, trailing slash and query, and rejects a non-LinkedIn url", () => {
		expect(canonicalPersonUrl("https://www.linkedin.com/in/x/")).toBe(
			"https://linkedin.com/in/x",
		);
		expect(canonicalPersonUrl("linkedin.com/in/x")).toBe(
			"https://linkedin.com/in/x",
		);
		expect(canonicalPersonUrl("https://www.linkedin.com/in/x?trk=public")).toBe(
			"https://linkedin.com/in/x",
		);
		expect(canonicalPersonUrl("https://example.com")).toBeNull();
		expect(canonicalPersonUrl(null)).toBeNull();
	});
});

describe("Clay's two-call search contract", () => {
	it("uses Clay's two-call search contract, mapping rows and metering records", async () => {
		const calls = stubClaySequence([
			{ response: jsonResponse({ search_id: "search-abc" }) },
			{ response: jsonResponse(searchPage) },
		]);
		const ledger = new CostLedger();
		const meterSpy = vi.spyOn(ledger, "metered");

		const result = await claySearch(
			clayEnv(),
			{ identifier: "harborit.com", bands: ["c-suite"], keywords: ["revenue"] },
			ledger,
		);

		const createHeaders = new Headers(calls.inits[0]?.headers);
		expect(createHeaders.get("clay-api-key")).toBe("test-clay-key");
		expect(JSON.parse(String(calls.inits[0]?.body))).toEqual({
			source_type: "people",
			filters: {
				company_identifier: ["harborit.com"],
				job_title_seniority_levels_v2: ["c-suite"],
				job_title_keywords: ["revenue"],
			},
		});
		expect(JSON.parse(String(calls.inits[1]?.body))).toEqual({ limit: 500 });
		expect(result.quotaUsed).toBe(2);
		expect(meterSpy).toHaveBeenCalledWith("clay", "search", 2, "records");
		expect(result.rows[0]).toEqual({
			name: "Priya Raman",
			title: "VP of Revenue Operations",
			company: "Harbor Robotics",
			url: "https://linkedin.com/in/priyaraman-vp",
			location: "Austin, Texas, United States",
			since: "2022-03-01",
		});
	});
});

describe("Clay paging", () => {
	it("stops Clay paging at the code ceiling", async () => {
		const page = { data: [{ name: "Someone" }], has_more: true };
		const calls = stubClaySequence([
			{ response: jsonResponse({ search_id: "search-xyz" }) },
			{ response: jsonResponse(page) },
			{ response: jsonResponse(page) },
			{ response: jsonResponse(page) },
			{ response: jsonResponse(page) },
			{ response: jsonResponse(page) },
		]);

		const result = await claySearch(
			clayEnv(),
			{ identifier: "harborit.com" },
			new CostLedger(),
		);

		expect(calls.runCalls).toBe(5);
		expect(result.rows).toHaveLength(5);
	});
});

describe("Clay failure modes", () => {
	it("throws RetryableProviderError on a request timeout", async () => {
		stubClaySequence([{ throwTimeout: true }]);

		await expect(
			claySearch(clayEnv(), { identifier: "harborit.com" }, new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
	});

	it("returns a clean empty result rather than an error", async () => {
		stubClaySequence([
			{ response: jsonResponse({ search_id: "search-empty" }) },
			{ response: jsonResponse({ data: [], has_more: false }) },
		]);

		const empty = await claySearch(
			clayEnv(),
			{ identifier: "harbormsp.com" },
			new CostLedger(),
		);

		expect(empty.rows).toEqual([]);
		expect(empty.rejected).toBe(false);
	});

	it("reports a 400 identifier rejection as rejected, not thrown", async () => {
		const calls = stubClaySequence([
			{ response: jsonResponse({ search_id: "search-rejected" }) },
			{ response: jsonResponse({ error: "invalid company_identifier" }, 400) },
		]);

		const rejected = await claySearch(
			clayEnv(),
			{ identifier: "notacompany.example" },
			new CostLedger(),
		);

		expect(rejected).toEqual({
			rows: [],
			raw: [
				JSON.stringify({ search_id: "search-rejected" }),
				JSON.stringify({ error: "invalid company_identifier" }),
			],
			quotaUsed: 0,
			rejected: true,
		});
		expect(calls.runCalls).toBe(1);
	});

	it("treats a run call's 500 after a successful create as retryable", async () => {
		stubClaySequence([
			{ response: jsonResponse({ search_id: "search-500" }) },
			{ response: jsonResponse({ error: "internal" }, 500) },
		]);

		await expect(
			claySearch(clayEnv(), { identifier: "harborit.com" }, new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
	});

	it("rejects a run response that does not match the expected shape", async () => {
		stubClaySequence([
			{ response: jsonResponse({ search_id: "search-bad-shape" }) },
			{ response: jsonResponse({ unexpected: true }) },
		]);

		await expect(
			claySearch(clayEnv(), { identifier: "harborit.com" }, new CostLedger()),
		).rejects.toThrow("Clay: run response did not match the expected shape");
	});
});

describe("Clay 429 retry", () => {
	it("retries once after a Retry-After wait and returns the retry's rows", async () => {
		const calls = stubClaySequence([
			{ response: jsonResponse({ search_id: "search-429" }) },
			{
				response: new Response(null, {
					status: 429,
					headers: { "retry-after": "1" },
				}),
			},
			{ response: jsonResponse(searchPage) },
		]);
		const sleeps = stubSleep();

		const result = await claySearch(
			clayEnv(),
			{ identifier: "harborit.com" },
			new CostLedger(),
		);

		expect(calls.runCalls).toBe(2);
		expect(sleeps.waits).toEqual([1000]);
		expect(result.rows).toHaveLength(2);
	});

	it("throws RetryableProviderError after a second 429", async () => {
		const calls = stubClaySequence([
			{ response: jsonResponse({ search_id: "search-429-429" }) },
			{ response: new Response(null, { status: 429 }) },
			{ response: new Response(null, { status: 429 }) },
		]);
		stubSleep();

		await expect(
			claySearch(clayEnv(), { identifier: "harborit.com" }, new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
		expect(calls.runCalls).toBe(2);
	});

	it("caps a Retry-After above the configured maximum", async () => {
		stubClaySequence([
			{ response: jsonResponse({ search_id: "search-429-cap" }) },
			{
				response: new Response(null, {
					status: 429,
					headers: { "retry-after": "3600" },
				}),
			},
			{ response: jsonResponse(searchPage) },
		]);
		const sleeps = stubSleep();

		await claySearch(
			clayEnv(),
			{ identifier: "harborit.com" },
			new CostLedger(),
		);

		expect(sleeps.waits).toEqual([5000]);
	});
});
