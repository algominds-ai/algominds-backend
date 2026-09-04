import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import { exaPeopleRoster } from "@/core/providers/exa/people-roster";
import { fakeSecretEnv } from "../support/env";
import {
	exaCompanySearchResponse,
	exaPeopleSearchResponse,
	respondInSequence,
} from "../support/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

const ORG_ID = "https://exa.ai/library/organization/acme";

describe("exaPeopleRoster", () => {
	it("sends a people-category search naming the company and its senior titles", async () => {
		const { fetch, calls } = respondInSequence([
			exaCompanySearchResponse(ORG_ID),
			exaPeopleSearchResponse([]),
		]);
		globalThis.fetch = fetch;

		await exaPeopleRoster(
			exaEnv(),
			{ domain: "acme.com", name: "Acme" },
			new CostLedger(),
		);

		const body: { query?: string; category?: string } = JSON.parse(
			String(calls[1]?.init?.body),
		);
		expect(body.category).toBe("people");
		expect(body.query).toContain("Acme");
		expect(body.query).toContain("founder");
	});

	it("drops a person whose current employer is a different organization id", async () => {
		globalThis.fetch = respondInSequence([
			exaCompanySearchResponse(ORG_ID),
			exaPeopleSearchResponse([
				{
					url: "https://www.linkedin.com/in/jane",
					name: "Jane Doe",
					currentTitle: "VP of Sales",
					currentCompany: "Other Corp",
					currentCompanyId: "https://exa.ai/library/organization/other",
				},
			]),
		]).fetch;

		const result = await exaPeopleRoster(
			exaEnv(),
			{ domain: "acme.com", name: "Acme" },
			new CostLedger(),
		);

		expect(result.rows).toEqual([]);
	});

	it("keeps a person whose current employer's organization id matches the company", async () => {
		globalThis.fetch = respondInSequence([
			exaCompanySearchResponse(ORG_ID),
			exaPeopleSearchResponse([
				{
					url: "https://www.linkedin.com/in/jane",
					name: "Jane Doe",
					currentTitle: "VP of Sales",
					currentCompany: "Acme Holdings",
					currentCompanyId: ORG_ID,
					location: "Austin, Texas",
				},
			]),
		]).fetch;

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

	it("returns an empty roster and makes no people search when no organization is found", async () => {
		const { fetch, calls } = respondInSequence([
			exaCompanySearchResponse(null),
		]);
		globalThis.fetch = fetch;

		const result = await exaPeopleRoster(
			exaEnv(),
			{ domain: "nobody.example", name: null },
			new CostLedger(),
		);

		expect(result.rows).toEqual([]);
		expect(calls).toHaveLength(1);
	});
});
