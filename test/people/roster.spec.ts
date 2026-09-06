import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { type PeopleProviderHints, seniorRoster } from "@/core/people/roster";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, stubClayCreateCapture } from "../support/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function clayEnv(): Env {
	return fakeSecretEnv({ CLAY_API_KEY: "test-clay-key" });
}

describe("senior roster retrieval", () => {
	it("retrieves only the ephemeral provider hint slices", async () => {
		const calls = stubClayCreateCapture();
		const buyer: PeopleProviderHints = {
			bands: ["founder", "head"],
			keywords: ["growth", "product"],
		};

		const result = await seniorRoster(
			"harborit.com",
			buyer,
			clayEnv(),
			new CostLedger(),
		);

		expect(calls.creates).toHaveLength(3);
		expect(calls.runCalls).toBe(3);
		expect(
			calls.creates.slice(0, 2).map((f) => f.job_title_seniority_levels_v2),
		).toEqual([["founder"], ["head"]]);
		for (const filters of calls.creates) {
			expect(filters.company_identifier).toEqual(["harborit.com"]);
		}
		expect(calls.creates[2]).toEqual({
			company_identifier: ["harborit.com"],
			job_title_keywords: ["growth", "product"],
		});
		expect(result.candidates).toEqual([]);
	});
});

const CreateFiltersSchema = z.object({
	company_identifier: z.array(z.string()),
	job_title_seniority_levels_v2: z.array(z.string()).optional(),
	job_title_keywords: z.array(z.string()).optional(),
});

function createConcurrentSearch(
	bandBySearchId: Map<string, string>,
	init: RequestInit | undefined,
): Response {
	const { filters } = z
		.object({ filters: CreateFiltersSchema })
		.parse(JSON.parse(String(init?.body)));
	const band = filters.job_title_seniority_levels_v2?.[0] ?? "none";
	bandBySearchId.set(`search-${band}`, band);
	return jsonResponse({ search_id: `search-${band}` });
}

async function runConcurrentSearch(
	bandBySearchId: Map<string, string>,
	path: string,
	cSuiteGate: Promise<void>,
): Promise<Response> {
	const band = bandBySearchId.get(path.split("/").at(-2) ?? "");
	if (band === "c-suite") await cSuiteGate;
	const name = band === "c-suite" ? "CSuite Person" : "VP Person";
	return jsonResponse({ data: [{ name }], has_more: false });
}

describe("senior roster retrieval under concurrent completion", () => {
	it("banks one ledger entry per slice even when an earlier slice's response resolves last", async () => {
		const bandBySearchId = new Map<string, string>();
		let releaseCSuite: (() => void) | undefined;
		const cSuiteGate = new Promise<void>((resolve) => {
			releaseCSuite = resolve;
		});

		globalThis.fetch = async (input, init) => {
			const path = new URL(String(input)).pathname;
			return path === "/public/v0/search/filters-mode"
				? createConcurrentSearch(bandBySearchId, init)
				: runConcurrentSearch(bandBySearchId, path, cSuiteGate);
		};

		const ledger = new CostLedger();
		const resultPromise = seniorRoster(
			"harborit.com",
			{ bands: ["c-suite", "vp"], keywords: [] },
			fakeSecretEnv({ CLAY_API_KEY: "test-clay-key" }),
			ledger,
		);

		await Promise.resolve();
		await Promise.resolve();
		releaseCSuite?.();

		const result = await resultPromise;

		expect(result.candidates.map((c) => c.name).sort()).toEqual([
			"CSuite Person",
			"VP Person",
		]);
		expect(ledger.toJSON().entries).toHaveLength(2);
	});
});
