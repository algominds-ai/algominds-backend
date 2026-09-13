import { afterEach, describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import { identifyCompanyRows } from "@/core/companies/identity";
import { retrieveCompanyEvidence } from "@/core/companies/proof";
import { CostLedger } from "@/core/cost";
import { exaContents } from "@/core/providers/exa/contents";
import declaredFallback from "../fixtures/exa-declared-linkedin-fallback.json";
import declaredLinkedIn from "../fixtures/exa-declared-linkedin-identity.json";
import rbc from "../fixtures/exa-rbc-native-identity.json";
import { companyCapture } from "../support/companies";
import { fakeSecretEnv } from "../support/env";
import { exaContentsFetch, jsonResponse, respondOnce } from "../support/fetch";

const nativeId = "https://exa.ai/library/organization/acme";
const canonicalUrl = "https://www.linkedin.com/company/acme";
const vendorUrl = "https://www.linkedin.com/company/vendor";
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const native = rbc.native.results[0];
if (!native) throw new Error("captured RBC native profile is missing");
const company: CompanyRow = {
	name: "RBC",
	domain: "rbc.com",
	linkedinUrl: rbc.mismatched.url,
	record: null,
	description: null,
};

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
describe("native company identity association", () => {
	it.each(
		declaredFallback,
	)("recovers $domain through the captured company-page fallback", async (fallback) => {
		const saved = declaredLinkedIn.find(
			({ row }) => row.domain === fallback.domain,
		);
		if (!saved) throw new Error("missing declared profile fixture");
		const captured = companyCapture();
		captured.result.id = saved.page.id;
		captured.evidence = captured.evidence.filter(
			(page) => page.sourceUrl === vendorUrl,
		);
		const ordinary = exaContentsFetch({
			[saved.row.linkedinUrl]: { text: saved.page.text },
			[`https://${fallback.domain}/`]: { text: "Company website" },
			[vendorUrl]: { text: "A vendor's case study about this customer." },
		});
		let searches = 0;
		globalThis.fetch = async (input, init) => {
			const body = JSON.parse(String(init?.body));
			if (body.ids) {
				expect(body.ids).toEqual([saved.page.id]);
				return jsonResponse({
					requestId: "retained-native",
					costDollars: { total: 0 },
					results: [saved.page],
					statuses: [{ id: saved.page.id, status: "success" }],
				});
			}
			if (new URL(String(input)).pathname === "/search") {
				expect(body).toEqual(fallback.request);
				searches++;
				return jsonResponse(fallback.response);
			}
			return ordinary(input, init);
		};
		const evidence = await retrieveCompanyEvidence(
			{
				rows: [saved.row],
				captures: { [fallback.domain]: captured },
				requirements: [],
			},
			fakeSecretEnv({ EXA_API_KEY: "offline" }),
			new CostLedger(),
		);
		const identified = identifyCompanyRows([saved.row], evidence.evidenceByRow);
		expect(searches).toBe(1);
		expect(identified.rows[0]?.linkedinUrl).toBe(fallback.expectedLinkedinUrl);
		expect(identified.rejects).toEqual([]);
		expect(evidence.evidenceByRow.get(0)?.has(vendorUrl)).toBe(true);
		expect(evidence.pages).toHaveLength(3);
		expect(evidence.pages.some((page) => page.url === saved.page.url)).toBe(
			false,
		);
	});
});

describe("native identity retrieval", () => {
	it("recovers a mismatched supplied profile using the captured native RBC response", async () => {
		const captured = companyCapture();
		captured.result.id = native.id;
		captured.evidence = captured.evidence.filter(
			(page) => page.sourceUrl === vendorUrl,
		);
		const ordinaryContents = exaContentsFetch({
			[company.linkedinUrl ?? ""]: { text: rbc.mismatched.text },
			"https://rbc.com/": { text: "RBC banking services" },
			[vendorUrl]: { text: "A vendor case study about RBC." },
		});
		let nativeCalls = 0;
		globalThis.fetch = async (input, init) => {
			const body = JSON.parse(String(init?.body));
			if (!body.ids) return ordinaryContents(input, init);
			expect(body.ids).toEqual([native.id]);
			nativeCalls++;
			return jsonResponse(rbc.native);
		};
		const ledger = new CostLedger();
		const evidence = await retrieveCompanyEvidence(
			{ rows: [company], captures: { "rbc.com": captured }, requirements },
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			ledger,
		);
		const identified = identifyCompanyRows([company], evidence.evidenceByRow);
		expect(nativeCalls).toBe(1);
		expect(identified.rows[0]?.linkedinUrl).toBe(
			"https://www.linkedin.com/company/rbc",
		);
		expect(identified.rejects).toEqual([]);
		expect(evidence.pages.map((page) => page.url)).not.toContain(
			rbc.mismatched.url,
		);
		expect(evidence.evidenceByRow.get(0)?.has(vendorUrl)).toBe(true);
		expect(ledger.total()).toBeCloseTo(0.007, 6);
	});

	it.each([
		{ error: {}, tag: null },
		{ error: { tag: "NOT_FOUND" }, tag: "NOT_FOUND" },
	])("preserves native IDs and per-ID failures with tag=$tag", async ({
		error,
		tag,
	}) => {
		const ids = [nativeId, "https://exa.ai/library/organization/missing"];
		const page = { id: nativeId, url: canonicalUrl, text: "Acme" };
		const captured = respondOnce(
			jsonResponse({
				requestId: "native-contents",
				results: [page],
				statuses: [
					{ id: ids[1], status: "error", error },
					{ id: nativeId, status: "success" },
				],
				costDollars: { total: 0.001 },
			}),
		);
		globalThis.fetch = captured.fetch;
		const ledger = new CostLedger();
		const env = fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
		const result = await exaContents(ids, env, ledger, { byId: true });
		const body = JSON.parse(String(captured.calls[0]?.init?.body));
		expect(body.ids).toEqual(ids);
		expect(body.urls).toBeUndefined();
		expect(result.results).toEqual([{ ...page, publishedDate: null }]);
		expect(result.statuses).toEqual([
			{ url: ids[1], status: "error", tag },
			{ url: nativeId, status: "success", tag: null },
		]);
		expect(ledger.total()).toBeCloseTo(0.001, 6);
	});
});
