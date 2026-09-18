import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import {
	exaOrganizationId,
	exaPeopleRoster,
} from "@/core/providers/exa/people-roster";
import { fakeSecretEnv } from "../support/env";
import {
	exaCompanySearchResponse,
	exaCompanySearchResultsResponse,
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
			return exaCompanySearchResponse(ORG_ID, "https://acme.com");
		};

		const lookup = await exaOrganizationId(
			exaEnv(),
			"acme.com",
			new CostLedger(),
		);

		expect(lookup.organizationId).toBe(ORG_ID);
		expect(body.category).toBe("company");
		expect(body.includeDomains).toEqual(["acme.com"]);
	});

	it("returns a null id and headcount when Exa's company index does not carry the domain", async () => {
		globalThis.fetch = async () => exaCompanySearchResponse(null);

		const lookup = await exaOrganizationId(
			exaEnv(),
			"nobody.example",
			new CostLedger(),
		);

		expect(lookup.organizationId).toBeNull();
		expect(lookup.workforceTotal).toBeNull();
	});

	it("skips a suffix-matched result and returns the one actually on the domain", async () => {
		globalThis.fetch = async () =>
			exaCompanySearchResultsResponse([
				{ id: "id-gatewise", url: "https://gatewise.com/" },
				{ id: "id-wise", url: "https://wise.com/about" },
			]);

		const lookup = await exaOrganizationId(
			exaEnv(),
			"wise.com",
			new CostLedger(),
		);

		expect(lookup.organizationId).toBe("id-wise");
	});

	it("returns null when none of the results are on the requested domain", async () => {
		globalThis.fetch = async () =>
			exaCompanySearchResultsResponse([
				{ id: "id-gatewise", url: "https://gatewise.com/" },
				{ id: "id-pairwise", url: "https://pairwise.com/" },
			]);

		const lookup = await exaOrganizationId(
			exaEnv(),
			"wise.com",
			new CostLedger(),
		);

		expect(lookup.organizationId).toBeNull();
	});

	it("reads the matched result's headcount from the same search, with no extra call", async () => {
		globalThis.fetch = async () =>
			exaCompanySearchResponse(ORG_ID, "https://acme.com", 0.005, 65);

		const lookup = await exaOrganizationId(
			exaEnv(),
			"acme.com",
			new CostLedger(),
		);

		expect(lookup.workforceTotal).toBe(65);
	});
});

describe("exaPeopleRoster", () => {
	it("sends an unfiltered people-category search naming the company", async () => {
		let body: { query?: string; category?: string } = {};
		globalThis.fetch = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return exaPeopleSearchResponse([]);
		};

		await exaPeopleRoster(
			exaEnv(),
			{
				domain: "acme.com",
				name: "Acme",
				linkedinUrl: null,
			},
			ORG_ID,
			new CostLedger(),
		);

		expect(body.category).toBe("people");
		expect(body.query).toBe(
			"People currently working at Acme, acme.com, official company acme.com",
		);
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
			{
				domain: "acme.com",
				name: "Acme",
				linkedinUrl: null,
			},
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
			{
				domain: "acme.com",
				name: "Acme",
				linkedinUrl: null,
			},
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
