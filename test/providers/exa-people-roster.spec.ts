import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import { exaPeopleRoster } from "@/core/providers/exa/people-roster";
import { fakeSecretEnv } from "../support/env";
import { exaPeopleSearchResponse } from "../support/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

describe("exaPeopleRoster", () => {
	it("sends a people-category search naming the company and its senior titles", async () => {
		let body: { query?: string; category?: string } = {};
		globalThis.fetch = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return exaPeopleSearchResponse([]);
		};

		await exaPeopleRoster(
			exaEnv(),
			{ domain: "acme.com", name: "Acme" },
			new CostLedger(),
		);

		expect(body.category).toBe("people");
		expect(body.query).toContain("Acme");
		expect(body.query).toContain("founder");
	});

	it("drops a result whose current employer is a different company", async () => {
		globalThis.fetch = async () =>
			exaPeopleSearchResponse([
				{
					url: "https://www.linkedin.com/in/jane",
					name: "Jane Doe",
					currentTitle: "VP of Sales",
					currentCompany: "Other Corp",
				},
			]);

		const result = await exaPeopleRoster(
			exaEnv(),
			{ domain: "acme.com", name: "Acme" },
			new CostLedger(),
		);

		expect(result.rows).toEqual([]);
	});

	it("keeps a result whose current employer names the company, as a roster row", async () => {
		globalThis.fetch = async () =>
			exaPeopleSearchResponse([
				{
					url: "https://www.linkedin.com/in/jane",
					name: "Jane Doe",
					currentTitle: "VP of Sales",
					currentCompany: "Acme Holdings",
					location: "Austin, Texas",
				},
			]);

		const result = await exaPeopleRoster(
			exaEnv(),
			{ domain: "acme.com", name: "Acme" },
			new CostLedger(),
		);

		expect(result.rows).toEqual([
			{
				name: "Jane Doe",
				title: "VP of Sales",
				company: "Acme Holdings",
				url: "https://www.linkedin.com/in/jane",
				location: "Austin, Texas",
				since: null,
				source: "exa:people",
			},
		]);
	});

	it("returns an empty list and spends nothing for an empty reply", async () => {
		globalThis.fetch = async () => exaPeopleSearchResponse([], 0);
		const ledger = new CostLedger();

		const result = await exaPeopleRoster(
			exaEnv(),
			{ domain: "nobody.example", name: null },
			ledger,
		);

		expect(result.rows).toEqual([]);
		expect(ledger.total()).toBe(0);
	});
});
