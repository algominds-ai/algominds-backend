import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { retrieveCompanyEvidence } from "@/core/companies/proof";
import { CostLedger } from "@/core/cost";
import recordedSource from "../../exports/company-cycle-2026-09-06/agent-source-check-1788681565740.json";
import { fakeSecretEnv } from "../support/env";
import { fakeVendors, jsonResponse } from "../support/fetch";

const urls = [
	"https://opentelemetry.io/blog/2026/devex-skyscanner/",
	"https://linkedin.com/company/skyscanner",
];

function row(): CompanyRow {
	return {
		name: "Skyscanner",
		domain: "skyscanner.net",
		linkedinUrl: urls[1] ?? null,
		description: null,
		record: null,
	};
}

function capture(): CompanyCapture {
	return {
		entity: {
			name: "Skyscanner",
			description: null,
			industry: null,
			foundedYear: null,
			workforceTotal: 1313,
			city: "Edinburgh",
			country: "United Kingdom",
			revenueAnnual: null,
			fundingTotal: null,
		},
		result: {
			id: null,
			url: "https://www.skyscanner.net",
			title: "Skyscanner",
			qualification: null,
		},
		evidence: urls.flatMap((url, index) =>
			Array.from({ length: index === 0 ? 2 : 1 }, (_, duplicate) => ({
				conditionId: `r${index + duplicate + 1}.a1.c1`,
				sourceUrl: url,
				quote: duplicate ? "another guessed quote" : "guessed quote",
				eventDate: null,
				publishedDate: "2099-01-01",
			})),
		),
		raw: "{}",
		source: "exa-agent",
	};
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function sourceResults() {
	const raw = z
		.object({
			response: z.object({
				results: z.array(
					z.object({
						url: z.string(),
						text: z.string(),
						publishedDate: z.string().nullish(),
					}),
				),
			}),
		})
		.parse(recordedSource);
	return raw.response.results.filter((result) => urls.includes(result.url));
}

function prepareContents(results: ReturnType<typeof sourceResults>) {
	globalThis.fetch = fakeVendors(
		{},
		{
			"/contents": (init) => {
				const body = ContentsBodySchema.parse(JSON.parse(String(init?.body)));
				expect(body.urls.length).toBeLessThanOrEqual(5);
				const fetched = results.filter((page) => body.urls.includes(page.url));
				return jsonResponse({
					requestId: "recorded-source-check",
					costDollars: { total: 0 },
					results: fetched,
					statuses: body.urls.map((url) =>
						fetched.some((page) => page.url === url)
							? { id: url, status: "success" }
							: {
									id: url,
									status: "error",
									error: { tag: "CRAWL_UNKNOWN_ERROR" },
								},
					),
				});
			},
		},
	);
}

const ContentsBodySchema = z.object({ urls: z.array(z.string()) });

function prepareFailedLinkedInContents(
	sourcePages: ReturnType<typeof sourceResults>,
	fallbackUrl: string,
	searchBodies: unknown[],
) {
	prepareContents(sourcePages.filter((page) => page.url !== urls[1]));
	const contentsFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		if (new URL(String(input)).pathname !== "/search")
			return contentsFetch(input, init);
		searchBodies.push(JSON.parse(String(init?.body)));
		return jsonResponse({
			requestId: "linkedin-fallback-search",
			costDollars: { total: 0 },
			results: [
				{
					id: "fallback-linkedin",
					url: fallbackUrl,
					title: "Skyscanner",
					text: "Skyscanner is a travel search company.",
				},
			],
		});
	};
}

describe("retrieveCompanyEvidence", () => {
	it("retrieves the later companies' sources when a batch needs more than 100 pages", async () => {
		const rows = Array.from({ length: 60 }, (_, index) => ({
			...row(),
			domain: `company${index}.example`,
			linkedinUrl: `https://linkedin.com/company/company${index}`,
		}));
		const captures = Object.fromEntries(
			rows.map((company) => [
				company.domain,
				{
					...capture(),
					evidence: capture().evidence.map((entry) => ({
						...entry,
						sourceUrl: `https://${company.domain}/proof`,
					})),
				},
			]),
		);
		prepareContents(
			rows.flatMap((company) =>
				[
					`https://${company.domain}/`,
					`https://${company.domain}/proof`,
					company.linkedinUrl,
				].map((url) => ({ url, text: `Fetched text for ${url}` })),
			),
		);
		const result = await retrieveCompanyEvidence(
			{ rows, captures, requirements: [] },
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);
		expect(result.pages).toHaveLength(180);
		expect(result.evidenceByRow.size).toBe(60);
		expect(
			[...result.evidenceByRow.values()].every((pages) => pages.size === 3),
		).toBe(true);
	});

	it("reuses LinkedIn host aliases and discards generated quotes and dates", async () => {
		const sourcePages = sourceResults();
		prepareContents(sourcePages);
		const result = await retrieveCompanyEvidence(
			{
				rows: [
					{
						...row(),
						linkedinUrl: "https://www.linkedin.com/company/skyscanner",
					},
				],
				captures: { "skyscanner.net": capture() },
				requirements: [],
			},
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);
		const evidence = result.evidenceByRow.get(0);
		expect(result.pages).toHaveLength(2);
		expect(evidence?.size).toBe(2);
		expect(
			[...(evidence?.values() ?? [])].every((entry) => entry.quote === ""),
		).toBe(true);
		expect(
			[...(evidence?.values() ?? [])].some(
				(entry) => entry.publishedDate === "2099-01-01",
			),
		).toBe(false);
	});

	it("searches for the native LinkedIn page when the supplied URL crawl fails", async () => {
		const sourcePages = sourceResults();
		const fallbackUrl = "https://www.linkedin.com/company/skyscanner";
		const searchBodies: unknown[] = [];
		prepareFailedLinkedInContents(sourcePages, fallbackUrl, searchBodies);
		const result = await retrieveCompanyEvidence(
			{
				rows: [row()],
				captures: { "skyscanner.net": capture() },
				requirements: [],
			},
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);
		const evidence = result.evidenceByRow.get(0);
		expect(searchBodies).toHaveLength(1);
		expect(searchBodies[0]).toMatchObject({
			includeDomains: ["linkedin.com/company"],
			contents: { text: { maxCharacters: expect.any(Number) } },
		});
		expect(result.pages.map((page) => page.url)).toContain(fallbackUrl);
		expect(evidence?.get(fallbackUrl)?.text).toContain("travel search");
		expect(result.pages.map((page) => page.url)).not.toContain(urls[1]);
	});
});
