import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CostLedger } from "../src/core/cost";
import { seniorRoster } from "../src/core/people/roster";
import { SENIOR_BANDS } from "../src/core/synthesize";

function clayEnv(): Env {
	return { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const CreateFiltersSchema = z.object({
	company_identifier: z.array(z.string()),
	job_title_seniority_levels_v2: z.array(z.string()).optional(),
	job_title_keywords: z.array(z.string()).optional(),
});

const CreateRequestSchema = z.object({ filters: CreateFiltersSchema });

type CreateFilters = z.infer<typeof CreateFiltersSchema>;

type CreateCapture = { creates: CreateFilters[]; runCalls: number };

function stubCreateCapture(): CreateCapture {
	const state: CreateCapture = { creates: [], runCalls: 0 };
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			const body = CreateRequestSchema.parse(JSON.parse(String(init?.body)));
			state.creates.push(body.filters);
			return jsonResponse(200, {
				search_id: `search-${state.creates.length}`,
			});
		}
		state.runCalls += 1;
		return jsonResponse(200, { data: [], has_more: false });
	};
	return state;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("senior roster retrieval", () => {
	it("retrieves only the buyer's captured slices", async () => {
		const calls = stubCreateCapture();
		const buyer = {
			bands: [...SENIOR_BANDS],
			keywordBands: [
				{ band: "manager" as const, keywords: ["HR", "recruiting"] },
			],
		};

		const result = await seniorRoster(
			"harborit.com",
			buyer,
			clayEnv(),
			new CostLedger(),
		);

		expect(calls.creates).toHaveLength(9);
		expect(calls.runCalls).toBe(9);
		expect(
			calls.creates.slice(0, 8).map((f) => f.job_title_seniority_levels_v2),
		).toEqual(SENIOR_BANDS.map((band) => [band]));
		for (const filters of calls.creates) {
			expect(filters.company_identifier).toEqual(["harborit.com"]);
		}
		expect(calls.creates[8]).toEqual({
			company_identifier: ["harborit.com"],
			job_title_seniority_levels_v2: ["manager"],
			job_title_keywords: ["HR", "recruiting"],
		});
		expect(result.candidates).toEqual([]);
	});
});
