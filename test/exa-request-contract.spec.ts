import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAgentRunRequest } from "../src/core/companies/agent-search";
import { buildSearchRequest } from "../src/core/companies/candidates";
import { CostLedger } from "../src/core/cost";
import type { PeopleCompany } from "../src/core/people/candidates";
import { buildPersonSearchRequest } from "../src/core/people/candidates";
import { startAgentRun } from "../src/core/providers/exa/agent";
import { search } from "../src/core/providers/exa/search";
import type { SearchPlan } from "../src/core/synthesize";

function planFor(query: string): SearchPlan {
	return {
		query,
		angle: "angle-1",
		userLocation: null,
		countries: [],
		minWorkforce: null,
		maxWorkforce: null,
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

/**
 * The same measured shape, minus the category enum. The person path sends a
 * category value outside the measured set, a known gap left for separate
 * work; every other field still has to conform.
 */
const SearchFieldsAndTypeSchema = z
	.object({
		...SEARCH_FIELDS_WITHOUT_CATEGORY,
		category: z.string().optional(),
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
		userLocation: "US",
		countries: ["United States"],
		minWorkforce: null,
		maxWorkforce: 20,
		...overrides,
	};
}

function samplePeopleCompany(): PeopleCompany {
	return { id: "company-1", domain: "acme.example", name: "Acme", exaId: null };
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

describe("person search request stays inside the measured Exa /search schema, aside from category", () => {
	it("emits only fields and enum values the measured schema allows", () => {
		const request = buildPersonSearchRequest(samplePeopleCompany(), {
			titles: ["Chief Executive Officer"],
			queryTemplate: "decision makers at {company}",
			userLocation: null,
		});

		expect(SearchFieldsAndTypeSchema.safeParse(request).success).toBe(true);
	});

	it("sends a category value from the measured enum", () => {
		const request = buildPersonSearchRequest(samplePeopleCompany(), {
			titles: ["Chief Executive Officer"],
			queryTemplate: "decision makers at {company}",
			userLocation: null,
		});

		expect(MeasuredSearchRequestSchema.safeParse(request).success).toBe(true);
	});
});

describe("agent run request stays inside the measured Exa /agent/runs schema", () => {
	it("emits only fields and enum values the measured schema allows", () => {
		const request = buildAgentRunRequest(
			planFor("small US software teams"),
			10,
			"low",
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
			buildAgentRunRequest(planFor("ten fintech companies"), 10, "low"),
			exaEnv(),
		);

		expect(
			MeasuredAgentRunRequestSchema.safeParse(postedBody(stub.init)).success,
		).toBe(true);
	});
});

describe("the people request carries only filters the people category accepts", () => {
	it("sends the country the model wrote, uppercased", () => {
		const request = buildPersonSearchRequest(samplePeopleCompany(), {
			titles: ["VP of Sales"],
			queryTemplate: "sales leaders at {company}",
			userLocation: "US",
		});

		expect(request.userLocation).toBe("US");
		expect(request.category).toBe("people");
	});

	it("omits the country entirely when the model named none", () => {
		const request = buildPersonSearchRequest(samplePeopleCompany(), {
			titles: ["VP of Sales"],
			queryTemplate: "sales leaders at {company}",
			userLocation: null,
		});

		expect("userLocation" in request).toBe(false);
	});

	it("never sends a filter the people category rejects", () => {
		const request = buildPersonSearchRequest(samplePeopleCompany(), {
			titles: ["VP of Sales"],
			queryTemplate: "sales leaders at {company}",
			userLocation: "US",
		});

		expect("excludeDomains" in request).toBe(false);
		expect("startPublishedDate" in request).toBe(false);
		expect("endPublishedDate" in request).toBe(false);
	});

	it("names the company where the model put its placeholder", () => {
		const request = buildPersonSearchRequest(samplePeopleCompany(), {
			titles: ["VP of Sales"],
			queryTemplate: "who leads revenue at {company} today",
			userLocation: null,
		});

		expect(request.query).toContain("who leads revenue at");
		expect(request.query).not.toContain("{company}");
	});
});
