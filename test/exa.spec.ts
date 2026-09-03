import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CostLedger } from "../src/core/cost";
import { exaContents } from "../src/core/providers/exa/contents";
import type { ExaSearchRequest } from "../src/core/providers/exa/search";
import { search } from "../src/core/providers/exa/search";
import { RetryableProviderError } from "../src/core/providers/waterfall";

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

type FetchStub = { calls: number; init: RequestInit | undefined; url: string };

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function exaEnv(): Env {
	return { ...testEnv, EXA_API_KEY: { get: async () => "test-exa-key" } };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function successBody(
	overrides: SuccessBodyOverrides = {},
): SuccessBodyOverrides {
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

function stubFetch(response: Response): FetchStub {
	const stub: FetchStub = { calls: 0, init: undefined, url: "" };
	globalThis.fetch = async (input, init) => {
		stub.calls += 1;
		stub.init = init;
		stub.url = String(input);
		return response;
	};
	return stub;
}

describe("search request shape", () => {
	it("sends the query with x-api-key and never a bearer token", async () => {
		const stub = stubFetch(jsonResponse(200, successBody()));

		await search({ query: "GTM leads" }, exaEnv(), new CostLedger());

		const headers = new Headers(stub.init?.headers);
		expect(headers.get("x-api-key")).toBe("test-exa-key");
		expect(headers.get("authorization")).toBeNull();
	});

	it("rejects category company combined with startPublishedDate before any network call, naming both fields", async () => {
		const stub = stubFetch(jsonResponse(200, successBody()));
		const req: ExaSearchRequest = {
			query: "seed stage fintech",
			category: "company",
			startPublishedDate: "2026-01-01",
		};

		let caught: unknown;
		try {
			await search(req, exaEnv(), new CostLedger());
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NonRetryableError);
		if (caught instanceof Error) {
			expect(caught.message).toContain("category");
			expect(caught.message).toContain("startPublishedDate");
		}
		expect(stub.calls).toBe(0);
	});

	it("fails schema validation on an unrecognised category rather than returning nothing", async () => {
		const stub = stubFetch(jsonResponse(200, successBody({ results: [] })));
		const req: ExaSearchRequest = JSON.parse(
			JSON.stringify({ query: "anything", category: "not-a-real-category" }),
		);

		await expect(search(req, exaEnv(), new CostLedger())).rejects.toThrow();
		expect(stub.calls).toBe(0);
	});
});

describe("search error mapping", () => {
	it("raises RetryableProviderError on a 429", async () => {
		stubFetch(
			jsonResponse(429, { requestId: "req-429", message: "slow down" }),
		);

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
	});

	it("raises NonRetryableError on a 400", async () => {
		stubFetch(
			jsonResponse(400, { requestId: "req-400", message: "bad request" }),
		);

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(NonRetryableError);
	});

	it("captures requestId on a 200", async () => {
		stubFetch(jsonResponse(200, successBody({ requestId: "req-ok-123" })));

		const result = await search(
			{ query: "GTM leads" },
			exaEnv(),
			new CostLedger(),
		);

		expect(result.requestId).toBe("req-ok-123");
	});

	it("captures requestId on a 500", async () => {
		stubFetch(
			jsonResponse(500, { requestId: "req-fail-500", message: "boom" }),
		);

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(/req-fail-500/);
	});
});

describe("search response shape", () => {
	it("raises NonRetryableError, not a raw Zod error, on a malformed 200 body, naming the requestId", async () => {
		stubFetch(
			jsonResponse(200, {
				requestId: "req-malformed",
				costDollars: { total: 0.01 },
				results: [{ url: "https://a.example" }],
			}),
		);

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
		stubFetch(jsonResponse(200, successBody()));
		const ledger = new CostLedger();

		await search({ query: "GTM leads" }, exaEnv(), ledger);

		const byProvider = ledger.byProvider();
		expect(byProvider["search.keyword"]).toBe(0.007);
		expect(byProvider.summary).toBe(0.003);
		expect(ledger.total()).toBeCloseTo(0.01, 5);
	});
});

describe("search under a hung connection", () => {
	it("times out shared calls as unknown", async () => {
		globalThis.fetch = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};

		await expect(
			search({ query: "GTM leads" }, exaEnv(), new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
	});
});

describe("search summary parsing", () => {
	it("yields a null summary for a result whose summary is not valid JSON, without failing the call", async () => {
		stubFetch(
			jsonResponse(
				200,
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
		);

		const result = await search(
			{ query: "GTM leads" },
			exaEnv(),
			new CostLedger(),
		);

		expect(result.results).toHaveLength(2);
		expect(result.results[0]?.summary).toBeNull();
		expect(result.results[1]?.summary).toEqual({ fullName: "Max Freeman" });
	});

	it("returns a valid JSON summary parsed into an object, not as a string", async () => {
		stubFetch(
			jsonResponse(
				200,
				successBody({
					results: [
						{
							url: "https://c.example",
							title: "C",
							summary: '{"currentTitle":"VP of Sales"}',
						},
					],
				}),
			),
		);

		const result = await search(
			{ query: "GTM leads" },
			exaEnv(),
			new CostLedger(),
		);

		expect(typeof result.results[0]?.summary).toBe("object");
		expect(result.results[0]?.summary).toEqual({ currentTitle: "VP of Sales" });
	});
});

const ContentsRequestSchema = z.object({
	urls: z.array(z.string()),
	text: z.object({ maxCharacters: z.number() }),
});

describe("contents request shape", () => {
	it("sends urls and a top-level text.maxCharacters, with x-api-key and never a bearer token", async () => {
		const stub = stubFetch(
			jsonResponse(200, {
				requestId: "req-contents-1",
				results: [{ url: "https://acme.example/team", text: "hello" }],
				statuses: [{ id: "https://acme.example/team", status: "success" }],
				costDollars: { total: 0.003 },
			}),
		);

		await exaContents(
			["https://acme.example/team"],
			exaEnv(),
			new CostLedger(),
		);

		expect(stub.url).toBe("https://api.exa.ai/contents");
		const headers = new Headers(stub.init?.headers);
		expect(headers.get("x-api-key")).toBe("test-exa-key");
		expect(headers.get("authorization")).toBeNull();
		const body = ContentsRequestSchema.parse(
			JSON.parse(String(stub.init?.body)),
		);
		expect(body).toEqual({
			urls: ["https://acme.example/team"],
			text: { maxCharacters: 20_000 },
		});
	});
});

describe("contents error mapping and cost", () => {
	it("raises RetryableProviderError on a 429", async () => {
		stubFetch(
			jsonResponse(429, { requestId: "req-429", message: "slow down" }),
		);

		await expect(
			exaContents(["https://acme.example/team"], exaEnv(), new CostLedger()),
		).rejects.toThrow(RetryableProviderError);
	});

	it("raises NonRetryableError on a malformed 200 body", async () => {
		stubFetch(jsonResponse(200, { requestId: "req-bad", results: "nope" }));

		await expect(
			exaContents(["https://acme.example/team"], exaEnv(), new CostLedger()),
		).rejects.toThrow(NonRetryableError);
	});

	it("banks costDollars.total into the ledger", async () => {
		stubFetch(
			jsonResponse(200, {
				requestId: "req-contents-2",
				results: [{ url: "https://acme.example/team", text: "hello" }],
				statuses: [{ id: "https://acme.example/team", status: "success" }],
				costDollars: { total: 0.003 },
			}),
		);
		const ledger = new CostLedger();

		await exaContents(["https://acme.example/team"], exaEnv(), ledger);

		expect(ledger.total()).toBeCloseTo(0.003, 5);
	});
});
