import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAgentRunRequest } from "../src/core/companies/agent-search";
import { buildSearchRequest } from "../src/core/companies/candidates";
import { CostLedger } from "../src/core/cost";
import { startAgentRun } from "../src/core/providers/exa/agent";
import { search } from "../src/core/providers/exa/search";
import type { SearchPlan } from "../src/core/synthesize";

function planFor(query: string): SearchPlan {
	return {
		query,
		angle: "angle-1",
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
		source: "exa-search",
		agentEffort: "low",
		userLocation: null,
		countries: [],
		minWorkforce: null,
		maxWorkforce: null,
		minFoundedYear: null,
		maxFoundedYear: null,
		minRevenueAnnual: null,
		maxRevenueAnnual: null,
		minFundingTotal: null,
		maxFundingTotal: null,
	};
}

const SEARCH_TYPES = [
	"instant",
	"fast",
	"auto",
	"deep-lite",
	"deep",
	"deep-reasoning",
] as const;

const SEARCH_CATEGORIES = [
	"company",
	"publication",
	"news",
	"personal site",
	"financial report",
	"people",
] as const;

const AGENT_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"auto",
	"max",
] as const;

const AGENT_PROVIDERS = [
	"fiber",
	"financial_datasets",
	"similarweb",
	"baselayer",
	"affiliate",
	"particle",
	"jinko",
] as const;

const SEARCH_FIELDS_WITHOUT_CATEGORY = {
	query: z.string(),
	type: z.enum(SEARCH_TYPES).optional(),
	numResults: z.number().int().min(1).max(100).optional(),
	includeDomains: z.array(z.string()).optional(),
	excludeDomains: z.array(z.string()).optional(),
	startPublishedDate: z.string().optional(),
	endPublishedDate: z.string().optional(),
	userLocation: z.string().length(2).optional(),
	additionalQueries: z.array(z.string()).optional(),
	systemPrompt: z.string().optional(),
	outputSchema: z.unknown().optional(),
	contents: z.unknown().optional(),
	moderation: z.unknown().optional(),
	compliance: z.unknown().optional(),
	stream: z.boolean().optional(),
};

/**
 * The `/search` request body a live probe and Exa's own OpenAPI schema both
 * confirm on 2026-08-27. Hand-encoded here rather than imported from source,
 * so a change to the request builder can never also change what this file
 * checks it against.
 */
const MeasuredSearchRequestSchema = z
	.object({
		...SEARCH_FIELDS_WITHOUT_CATEGORY,
		category: z.enum(SEARCH_CATEGORIES).optional(),
	})
	.strict();

/** The `/agent/runs` request body, measured the same way as the `/search` one above. */
const MeasuredAgentRunRequestSchema = z
	.object({
		query: z.string(),
		systemPrompt: z.string().optional(),
		outputSchema: z.unknown().optional(),
		effort: z.enum(AGENT_EFFORTS).optional(),
		previousRunId: z.string().optional(),
		dataSources: z
			.array(z.object({ provider: z.enum(AGENT_PROVIDERS) }).strict())
			.max(5)
			.optional(),
		budget: z
			.object({ maxCostDollars: z.number().min(1).max(100) })
			.strict()
			.optional(),
		input: z.object({ data: z.unknown() }).strict().optional(),
		metadata: z.record(z.string(), z.string()).optional(),
	})
	.strict();

function samplePlan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "fintech companies at seed stage with a small team",
		angle: "founder-led vertical software",
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
		source: "exa-search",
		agentEffort: "low",
		userLocation: "US",
		countries: ["United States"],
		minWorkforce: null,
		maxWorkforce: 20,
		minFoundedYear: null,
		maxFoundedYear: null,
		minRevenueAnnual: null,
		maxRevenueAnnual: null,
		minFundingTotal: null,
		maxFundingTotal: null,
		...overrides,
	};
}

describe("company search request stays inside the measured Exa /search schema", () => {
	it("emits only fields and enum values the measured schema allows", () => {
		const request = buildSearchRequest(samplePlan());

		const parsed = MeasuredSearchRequestSchema.safeParse(request);

		expect(parsed.success).toBe(true);
		expect(request.category).toBe("company");
	});

	it("still conforms with no user location on the profile", () => {
		const request = buildSearchRequest(samplePlan({ userLocation: null }));

		expect(MeasuredSearchRequestSchema.safeParse(request).success).toBe(true);
	});
});

describe("the search query carries the plan's bounds", () => {
	it("appends the numeric bounds and countries as sentences after the descriptive query", () => {
		const request = buildSearchRequest(samplePlan());

		expect(request.query).toBe(
			"fintech companies at seed stage with a small team Every company must have a headcount of at most 20. Every company must be based in United States.",
		);
	});

	it("leaves the query unchanged when the plan carries no bounds and no countries", () => {
		const request = buildSearchRequest(
			samplePlan({ maxWorkforce: null, countries: [] }),
		);

		expect(request.query).toBe(
			"fintech companies at seed stage with a small team",
		);
	});
});

describe("agent run request stays inside the measured Exa /agent/runs schema", () => {
	it("emits only fields and enum values the measured schema allows", () => {
		const request = buildAgentRunRequest(
			planFor("small US software teams"),
			10,
			"2026-08-30",
			null,
		);

		const parsed = MeasuredAgentRunRequestSchema.safeParse(request);

		expect(parsed.success).toBe(true);
		expect(request.dataSources?.length).toBeLessThanOrEqual(5);
	});
});

describe("the measured schemas reject exactly the defects that shipped unnoticed", () => {
	it("rejects a field Exa's /search does not define", () => {
		const withUnknownField = {
			query: "seed stage fintech",
			includeText: ["only match this phrase"],
		};

		expect(
			MeasuredSearchRequestSchema.safeParse(withUnknownField).success,
		).toBe(false);
	});

	it("rejects a search type outside the enum Exa accepts", () => {
		const withInvalidType = { query: "seed stage fintech", type: "neural" };

		expect(MeasuredSearchRequestSchema.safeParse(withInvalidType).success).toBe(
			false,
		);
		expect(
			MeasuredSearchRequestSchema.safeParse({
				query: "seed stage fintech",
				type: "auto",
			}).success,
		).toBe(true);
	});

	it("rejects a numResults outside 1 to 100", () => {
		expect(
			MeasuredSearchRequestSchema.safeParse({ query: "x", numResults: 0 })
				.success,
		).toBe(false);
		expect(
			MeasuredSearchRequestSchema.safeParse({ query: "x", numResults: 101 })
				.success,
		).toBe(false);
	});

	it("rejects a field the agent endpoint does not define", () => {
		const withUnknownField = {
			query: "ten fintech companies",
			includeText: ["never a real field here either"],
		};

		expect(
			MeasuredAgentRunRequestSchema.safeParse(withUnknownField).success,
		).toBe(false);
	});

	it("rejects an agent effort or data source outside the measured set", () => {
		expect(
			MeasuredAgentRunRequestSchema.safeParse({
				query: "x",
				effort: "extreme",
			}).success,
		).toBe(false);
		expect(
			MeasuredAgentRunRequestSchema.safeParse({
				query: "x",
				dataSources: [{ provider: "not-a-real-provider" }],
			}).success,
		).toBe(false);
	});
});

describe("what reaches the network matches what the builder produced", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function exaEnv(): Env {
		return { ...testEnv, EXA_API_KEY: { get: async () => "test-exa-key" } };
	}

	function stubFetch(response: Response): { init: RequestInit | undefined } {
		const stub: { init: RequestInit | undefined } = { init: undefined };
		globalThis.fetch = async (_input, init) => {
			stub.init = init;
			return response;
		};
		return stub;
	}

	function postedBody(init: RequestInit | undefined): unknown {
		if (typeof init?.body !== "string")
			throw new Error("expected a posted body");
		return JSON.parse(init.body);
	}

	it("posts the company search request unchanged", async () => {
		const stub = stubFetch(
			new Response(
				JSON.stringify({
					requestId: "req-1",
					costDollars: { total: 0 },
					results: [],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		await search(buildSearchRequest(samplePlan()), exaEnv(), new CostLedger());

		expect(
			MeasuredSearchRequestSchema.safeParse(postedBody(stub.init)).success,
		).toBe(true);
	});

	it("posts the agent run request unchanged", async () => {
		const stub = stubFetch(
			new Response(JSON.stringify({ id: "run-1", status: "running" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await startAgentRun(
			buildAgentRunRequest(
				planFor("ten fintech companies"),
				10,
				"2026-08-30",
				null,
			),
			exaEnv(),
		);

		expect(
			MeasuredAgentRunRequestSchema.safeParse(postedBody(stub.init)).success,
		).toBe(true);
	});
});

describe("the search request runs at fast, the only type a search round pins", () => {
	it("sends fast and no additionalQueries, since nothing reads them at fast", () => {
		const request = buildSearchRequest(samplePlan());

		expect(request.type).toBe("fast");
		expect(request.additionalQueries).toBeUndefined();
	});
});

describe("the plan chooses how hard the agent works", () => {
	it("sends the effort the plan picked, not a fixed setting", () => {
		const request = buildAgentRunRequest(
			samplePlan({ agentEffort: "medium" }),
			5,
			"2026-08-30",
			null,
		);

		expect(request.effort).toBe("medium");
	});
});
