import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "../src/core/cost";
import { claySearch } from "../src/core/providers/clay";
import { RetryableProviderError } from "../src/core/providers/waterfall";
import searchPage from "./fixtures/clay-search.json";

function clayEnv(): Env {
	return { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function isCreateCall(input: unknown): boolean {
	return new URL(String(input)).pathname === "/public/v0/search/filters-mode";
}

type SequenceStep = { response: Response } | { throwTimeout: true };

function stubClaySequence(steps: SequenceStep[]): { runCalls: number } {
	const calls = { runCalls: 0 };
	let step = 0;
	globalThis.fetch = async (input) => {
		const current = steps[step] ?? steps[steps.length - 1];
		step += 1;
		if (!isCreateCall(input)) calls.runCalls += 1;
		if (!current) return new Response(null, { status: 404 });
		if ("throwTimeout" in current) {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}
		return current.response;
	};
	return calls;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Clay's two-call search contract", () => {
	it("uses Clay's two-call search contract", async () => {
		stubClaySequence([
			{ response: jsonResponse(200, { search_id: "search-abc" }) },
			{ response: jsonResponse(200, searchPage) },
		]);

		const result = await claySearch(
			clayEnv(),
			{ identifier: "harborit.com" },
			new CostLedger(),
		);

		expect(result.rows).toEqual([
			{
				name: "Priya Raman",
				title: "VP of Revenue Operations",
				company: "Harbor Robotics",
				url: "https://linkedin.com/in/priyaraman-vp",
				location: "Austin, Texas, United States",
				since: "2022-03-01",
			},
			{
				name: "Devon Ashworth",
				title: "Chief Revenue Officer",
				company: "Harbor Robotics",
				url: "https://linkedin.com/in/devonashworth",
				location: "Remote",
				since: "2020-11-15",
			},
		]);
		expect(result.raw).toHaveLength(2);
		expect(JSON.parse(result.raw[0] ?? "")).toEqual({
			search_id: "search-abc",
		});
		expect(JSON.parse(result.raw[1] ?? "")).toEqual(searchPage);
	});
});

describe("Clay paging", () => {
	it("stops Clay paging at the code ceiling", async () => {
		const page = { data: [{ name: "Someone" }], has_more: true };
		const calls = stubClaySequence([
			{ response: jsonResponse(200, { search_id: "search-xyz" }) },
			{ response: jsonResponse(200, page) },
			{ response: jsonResponse(200, page) },
			{ response: jsonResponse(200, page) },
			{ response: jsonResponse(200, page) },
			{ response: jsonResponse(200, page) },
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
	it("distinguishes timeout, invalid reply, and clean empty", async () => {
		stubClaySequence([{ throwTimeout: true }]);
		await expect(
			claySearch(clayEnv(), { identifier: "harborit.com" }, new CostLedger()),
		).rejects.toThrow(RetryableProviderError);

		stubClaySequence([{ response: jsonResponse(200, {}) }]);
		await expect(
			claySearch(clayEnv(), { identifier: "harborit.com" }, new CostLedger()),
		).rejects.toThrow(NonRetryableError);

		stubClaySequence([
			{ response: jsonResponse(200, { search_id: "search-empty" }) },
			{ response: jsonResponse(200, { data: [], has_more: false }) },
		]);
		const empty = await claySearch(
			clayEnv(),
			{ identifier: "harbormsp.com" },
			new CostLedger(),
		);
		expect(empty.rows).toEqual([]);
	});
});
