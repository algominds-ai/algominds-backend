import { afterEach, describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import { identifyCompanyRows } from "@/core/companies/identity";
import { judge } from "@/core/companies/judge";
import { retrieveCompanyEvidence } from "@/core/companies/proof";
import { CostLedger } from "@/core/cost";
import mismatch from "../fixtures/company-parent-linkedin-mismatch.json";
import { companyCapture } from "../support/companies";
import { fakeGatewayEnv, fakeSecretEnv } from "../support/env";
import {
	chatCompletionResponse,
	exaContentsFetch,
	fakeGateway,
	jsonResponse,
} from "../support/fetch";

const nativeId = "https://exa.ai/library/organization/acme";
const sisterUrl = "https://www.linkedin.com/company/acme-sister";
const legacyUrl = "https://www.linkedin.com/company/acme-legacy";
const canonicalUrl = "https://www.linkedin.com/company/acme";
const vendorUrl = "https://www.linkedin.com/company/vendor";
const requirements = [
	{
		kind: "required" as const,
		anyOf: [
			{
				allOf: [
					{ text: "Runs the vendor's system", window: null, sourceRule: null },
				],
			},
		],
	},
];
const identityCases = [
	{
		ambiguous: false,
		reverse: false,
	},
	{
		ambiguous: false,
		reverse: true,
	},
	{ ambiguous: true, reverse: true },
	{ ambiguous: true, reverse: false },
];

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function rows(reverse: boolean): CompanyRow[] {
	const result = ["acme.test", "other.test"].map((domain) => ({
		name: domain,
		domain,
		linkedinUrl: null,
		description: null,
		record: null,
	}));
	return reverse ? result.reverse() : result;
}

function prepareSources(ambiguous: boolean): void {
	const contentsFetch = exaContentsFetch({
		"https://acme.test/": { text: "Acme's company website" },
		"https://other.test/": { text: "Another company" },
		[sisterUrl]: { text: "- Homepage: acme.test" },
		[vendorUrl]: {
			text: "Customer case study: Acme runs the vendor's system.",
		},
	});
	globalThis.fetch = async (input, init) => {
		const body = JSON.parse(String(init?.body));
		if (body.ids) {
			expect(body.ids).toEqual([nativeId]);
			expect(body.urls).toBeUndefined();
			return jsonResponse({
				requestId: "native-association",
				costDollars: { total: 0 },
				statuses: [{ id: nativeId, status: "success" }],
				results: [canonicalUrl, ...(ambiguous ? [legacyUrl] : [])].map(
					(url) => ({
						id: nativeId,
						url,
						text: `## Company Details\n- Homepage: acme.test\n- LinkedIn: ${url}`,
					}),
				),
			});
		}
		if (new URL(String(input)).pathname === "/search")
			return jsonResponse({
				requestId: "other-company-search",
				costDollars: { total: 0 },
				results: [
					{ url: canonicalUrl, title: "Other", text: "- Homepage: other.test" },
				],
			});
		return contentsFetch(input, init);
	};
}

function prepareVerdicts(companies: CompanyRow[]): void {
	globalThis.fetch = fakeGateway([
		chatCompletionResponse({
			content: JSON.stringify({
				verdicts: companies.map((_company, index) => ({
					index,
					statuses: [
						{
							id: "r1.a1.c1",
							status: "proven",
							sourceUrl: vendorUrl,
							date: null,
						},
					],
					reason: "Vendor's customer case study establishes deployment.",
				})),
			}),
		}),
	]).fetch;
}

describe("company LinkedIn identity", () => {
	it("rejects the captured parent website joined to a subsidiary's LinkedIn homepage", () => {
		const identified = identifyCompanyRows(
			[mismatch.row],
			new Map([
				[0, new Map([[mismatch.page.url, { ...mismatch.page, quote: "" }]])],
			]),
		);
		expect(identified.rows).toEqual([]);
		expect(identified.evidenceByRow.size).toBe(0);
		expect(identified.rejects).toEqual([
			{
				domain: mismatch.row.domain,
				stage: "gate",
				reason:
					"company website and LinkedIn identity were not verified by the provider",
			},
		]);
	});

	it("does not accept an indexed LinkedIn URL without retrieved provider evidence", () => {
		const identified = identifyCompanyRows(
			[
				{
					name: "Acme",
					domain: "acme.test",
					linkedinUrl: canonicalUrl,
					record: null,
					description: null,
				},
			],
			new Map(),
		);
		expect(identified.rows).toEqual([]);
		expect(identified.rejects[0]?.stage).toBe("gate");
	});
});

describe("provider identity is resolved before fit", () => {
	it.each(
		identityCases,
	)("resolves native identity before fit with ambiguous=$ambiguous and reverse=$reverse", async ({
		ambiguous,
		reverse,
	}) => {
		prepareSources(ambiguous);
		const companies = rows(reverse);
		const index = companies.findIndex(
			(company) => company.domain === "acme.test",
		);
		const evidence = await retrieveCompanyEvidence(
			{
				rows: companies,
				captures: { "acme.test": companyCapture() },
				requirements,
			},
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);
		const pages = evidence.evidenceByRow.get(index);
		expect(pages?.get(vendorUrl)?.text).toContain("Acme runs");
		expect(pages?.get(sisterUrl)?.identityAllowed).toBe(false);
		const identified = identifyCompanyRows(companies, evidence.evidenceByRow);
		const identifiedIndex = identified.rows.findIndex(
			(company) => company.domain === "acme.test",
		);
		if (ambiguous) {
			expect(identifiedIndex).toBe(-1);
			expect(identified.rows.map((company) => company.domain)).toEqual([
				"other.test",
			]);
			const otherIndex = companies.findIndex(
				(company) => company.domain === "other.test",
			);
			expect(identified.evidenceByRow.get(0)).toBe(
				evidence.evidenceByRow.get(otherIndex),
			);
			expect(identified.rejects).toContainEqual({
				domain: "acme.test",
				stage: "gate",
				reason:
					"company website and LinkedIn identity were not verified by the provider",
			});
			return;
		}
		expect(identified.rows[identifiedIndex]?.linkedinUrl).toBe(canonicalUrl);
		expect(identified.evidenceByRow.get(identifiedIndex)).toBe(pages);
		expect(pages?.get(canonicalUrl)).toMatchObject({
			url: canonicalUrl,
			text: expect.stringContaining("Homepage: acme.test"),
			identityAllowed: true,
		});
		prepareVerdicts(identified.rows);
		const result = await judge(
			requirements,
			identified.rows,
			fakeGatewayEnv(),
			{ evidenceByRow: identified.evidenceByRow },
		);
		expect(result.verdicts[identifiedIndex]?.statuses[0]).toMatchObject({
			status: "proven",
			sourceUrl: vendorUrl,
		});
		expect(result.verdicts[identifiedIndex]).not.toHaveProperty("linkedinUrl");
		expect(result.verdicts[identifiedIndex]).not.toHaveProperty(
			"sameOrganizationAs",
		);
	});
});
