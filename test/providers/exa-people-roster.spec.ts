import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import {
	exaOrganizationId,
	exaPeopleRoster,
} from "@/core/providers/exa/people-roster";
import { fakeSecretEnv } from "../support/env";
import {
	exaCompanySearchResponse,
	exaPeopleSearchResponse,
} from "../support/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

const ORG_ID = "https://exa.ai/library/organization/acme";

describe("exaOrganizationId", () => {
	it("sends a company-category search restricted to the domain", async () => {
		let body: { query?: string; category?: string; includeDomains?: string[] } =
			{};
		globalThis.fetch = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return exaCompanySearchResponse(ORG_ID);
		};

		const id = await exaOrganizationId(exaEnv(), "acme.com", new CostLedger());

		expect(id).toBe(ORG_ID);
		expect(body.category).toBe("company");
		expect(body.includeDomains).toEqual(["acme.com"]);
	});

	it("returns null when Exa's company index does not carry the domain", async () => {
		globalThis.fetch = async () => exaCompanySearchResponse(null);

		const id = await exaOrganizationId(
			exaEnv(),
			"nobody.example",
			new CostLedger(),
		);

		expect(id).toBeNull();
	});
});

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
			ORG_ID,
			new CostLedger(),
		);

		expect(body.category).toBe("people");
		expect(body.query).toContain("Acme");
		expect(body.query).toContain("founder");
	});

	it("drops a person whose current employer is a different organization id", async () => {
		globalThis.fetch = async () =>
			exaPeopleSearchResponse([
				{
					url: "https://www.linkedin.com/in/jane",
					name: "Jane Doe",
					currentTitle: "VP of Sales",
					currentCompany: "Other Corp",
					currentCompanyId: "https://exa.ai/library/organization/other",
				},
			]);

		const result = await exaPeopleRoster(
			exaEnv(),
			{ domain: "acme.com", name: "Acme" },
			ORG_ID,
			new CostLedger(),
		);

		expect(result.rows).toEqual([]);
	});

	it("keeps a person whose current employer's organization id matches the company", async () => {
		globalThis.fetch = async () =>
			exaPeopleSearchResponse([
				{
					url: "https://www.linkedin.com/in/jane",
					name: "Jane Doe",
					currentTitle: "VP of Sales",
					currentCompany: "Acme Holdings",
					currentCompanyId: ORG_ID,
					location: "Austin, Texas",
				},
			]);

		const result = await exaPeopleRoster(
			exaEnv(),
			{ domain: "acme.com", name: "Acme" },
			ORG_ID,
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
});
