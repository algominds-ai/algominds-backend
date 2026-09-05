import { afterEach, describe, expect, it } from "vitest";
import { fetchHomepages } from "@/core/companies/homepages";
import { CostLedger } from "@/core/cost";
import { fakeSecretEnv } from "../support/env";
import { exaContentsFetch, jsonResponse } from "../support/fetch";

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("fetchHomepages", () => {
	it("keeps only the domains whose homepage crawled with real text", async () => {
		globalThis.fetch = exaContentsFetch({
			"https://good.com/": { text: "Good Co sells widgets to banks." },
			"https://missing.com/": { errorTag: "CRAWL_NOT_FOUND" },
			"https://blank.com/": { text: "" },
		});
		const ledger = new CostLedger();

		const pages = await fetchHomepages(
			["good.com", "missing.com", "blank.com"],
			exaEnv(),
			ledger,
		);

		expect(pages).toEqual([
			{
				domain: "good.com",
				url: "https://good.com/",
				text: "Good Co sells widgets to banks.",
			},
		]);
		expect(ledger.total()).toBeGreaterThan(0);
	});

	it("returns nothing, not an error, when the vendor answers with a shape it does not read", async () => {
		globalThis.fetch = async () => jsonResponse({ unexpected: true });
		const pages = await fetchHomepages(
			["acme.com"],
			exaEnv(),
			new CostLedger(),
		);
		expect(pages).toEqual([]);
	});

	it("never calls Exa for an empty domain list", async () => {
		globalThis.fetch = () => {
			throw new Error("should not fetch");
		};

		const pages = await fetchHomepages([], exaEnv(), new CostLedger());

		expect(pages).toEqual([]);
	});
});
