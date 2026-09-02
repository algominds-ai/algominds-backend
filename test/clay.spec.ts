import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it, vi } from "vitest";
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

type ClayCalls = { runCalls: number; inits: (RequestInit | undefined)[] };

function stubClaySequence(steps: SequenceStep[]): ClayCalls {
	const calls: ClayCalls = { runCalls: 0, inits: [] };
	let step = 0;
	globalThis.fetch = async (input, init) => {
		calls.inits.push(init);
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
		const calls = stubClaySequence([
			{ response: jsonResponse(200, { search_id: "search-abc" }) },
			{ response: jsonResponse(200, searchPage) },
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
		expect(result.rows).toEqual(
			Array.from({ length: 5 }, () =>
				expect.objectContaining({ name: "Someone" }),
			),
		);
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
		expect(empty.rejected).toBe(false);

		const rejectCalls = stubClaySequence([
			{ response: jsonResponse(200, { search_id: "search-rejected" }) },
			{ response: jsonResponse(400, { error: "invalid company_identifier" }) },
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
		expect(rejectCalls.runCalls).toBe(1);
	});
});
