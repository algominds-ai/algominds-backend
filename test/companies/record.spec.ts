import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { backfillRecords } from "../../src/core/companies/record";
import { CostLedger } from "../../src/core/cost";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, stubSleep } from "../support/fetch";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.unstubAllGlobals();
});
function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

describe("company record backfill waits between concurrency slices", () => {
	it("batches exact records and falls back only for missing domains, preserving order", async () => {
		const requests: string[][] = [];
		globalThis.fetch = async (_input, init) => {
			const { includeDomains } = z
				.object({ includeDomains: z.array(z.string()) })
				.parse(JSON.parse(String(init?.body)));
			requests.push(includeDomains);
			const domains =
				includeDomains.length > 1
					? ["a.com", "gatewise.com", "b.wise.com", "a.com/p", "b.a.com"]
					: includeDomains;
			return jsonResponse({
				requestId: "req-record-batch",
				costDollars: { total: 0 },
				results: domains.map((domain) => ({
					url: `https://${domain}`,
					title: domain,
					entities: [{ type: "company", properties: { name: domain } }],
				})),
			});
		};

		const filled = await backfillRecords(
			["wise.com", "a.com", "b.com"],
			exaEnv(),
			new CostLedger(),
		);

		expect(requests).toEqual([
			["wise.com", "a.com", "b.com"],
			["wise.com"],
			["b.com"],
		]);
		expect(
			filled.map(({ domain, record }) => [domain, record?.company?.name]),
		).toEqual([
			["wise.com", "wise.com"],
			["a.com", "a.com"],
			["b.com", "b.com"],
		]);
	});

	it("does not substitute a division returned by an individual lookup", async () => {
		globalThis.fetch = async () =>
			jsonResponse({
				requestId: "req-division",
				costDollars: { total: 0 },
				results: [
					{
						url: "https://a.com/product",
						title: "A Product",
						entities: [{ type: "company", properties: { name: "A Product" } }],
					},
				],
			});
		expect(
			await backfillRecords(["a.com"], exaEnv(), new CostLedger()),
		).toEqual([{ domain: "a.com", record: null }]);
	});

	it("waits one second between slices when more than one is needed, never when one suffices", async () => {
		globalThis.fetch = async () =>
			jsonResponse({
				requestId: "req-backfill",
				costDollars: { total: 0 },
				results: [],
			});
		const sleeps = stubSleep();
		const domains = Array.from(
			{ length: 7 },
			(_, index) => `company-${index}.com`,
		);

		await backfillRecords(domains, exaEnv(), new CostLedger());
		expect(sleeps.waits).toEqual([1000]);

		sleeps.waits.length = 0;
		await backfillRecords(["a.com", "b.com"], exaEnv(), new CostLedger());
		expect(sleeps.waits).toEqual([]);
	});
});
