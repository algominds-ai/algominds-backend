import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
	ApolloFilterSchema,
	apolloPeopleSearch,
} from "../src/core/providers/apollo";
import { RetryableProviderError } from "../src/core/providers/waterfall";
import apolloCapture from "./fixtures/apollo-people-search.json";

function apolloEnv(): Env {
	return {
		...testEnv,
		APOLLO_API_KEY: { get: async () => "test-key" },
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const RAW_PERSON = {
	id: "person-1",
	first_name: "Max",
	last_name_obfuscated: "Fr***n",
	title: "SVP of Sales",
	organization: { name: "Ramp" },
	has_email: true,
	has_direct_phone: false,
	last_refreshed_at: "2026-08-01T00:00:00Z",
};

describe("ApolloFilterSchema", () => {
	it("accepts every allow-listed key at once", () => {
		const filters = {
			person_titles: ["VP of Sales"],
			person_seniorities: ["vp"],
			person_department_or_subdepartments: ["sales"],
			person_locations: ["San Francisco"],
			q_organization_domains_list: ["ramp.com"],
			organization_num_employees_ranges: ["1,10"],
			q_keywords: "revenue",
			page: 1,
			per_page: 50,
		};

		expect(ApolloFilterSchema.parse(filters)).toEqual(filters);
	});

	it("rejects a filter key outside the allow-list", () => {
		expect(() =>
			ApolloFilterSchema.parse({ totally_made_up_filter: ["x"] }),
		).toThrow();
	});

	it("rejects more than 1000 organization domains", () => {
		const many = Array.from({ length: 1001 }, (_, i) => `d${i}.com`);

		expect(() =>
			ApolloFilterSchema.parse({ q_organization_domains_list: many }),
		).toThrow();
	});

	it("rejects a per_page above 100", () => {
		expect(() => ApolloFilterSchema.parse({ per_page: 101 })).toThrow();
	});
});

describe("apolloPeopleSearch", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("never reaches the network when a filter key is unknown", async () => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return jsonResponse(200, { total_entries: 0, people: [] });
		};
		const untrustedFilters = JSON.parse('{"totally_made_up_filter":["x"]}');

		await expect(
			apolloPeopleSearch.run(untrustedFilters, apolloEnv()),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});

	it("maps a person to a coverage candidate with no email field", async () => {
		globalThis.fetch = async () =>
			jsonResponse(200, { total_entries: 1, people: [RAW_PERSON] });

		const result = await apolloPeopleSearch.run(
			{ person_seniorities: ["vp"] },
			apolloEnv(),
		);

		expect(result).toEqual({
			totalEntries: 1,
			candidates: [
				{
					id: "person-1",
					firstName: "Max",
					lastNameObfuscated: "Fr***n",
					title: "SVP of Sales",
					organizationName: "Ramp",
					hasEmail: true,
					hasDirectPhone: false,
					lastRefreshedAt: "2026-08-01T00:00:00Z",
				},
			],
		});
		expect(result?.candidates[0]).not.toHaveProperty("email");
	});

	it("never sends a personal-email or phone reveal flag", async () => {
		let sentBody = "";
		globalThis.fetch = async (_input, init) => {
			sentBody = String(init?.body ?? "");
			return jsonResponse(200, { total_entries: 0, people: [] });
		};

		await apolloPeopleSearch.run({ person_seniorities: ["vp"] }, apolloEnv());

		expect(sentBody).not.toContain("reveal_personal_emails");
		expect(sentBody).not.toContain("reveal_phone_number");
	});

	it("raises a retryable error on a 429 so the step can retry", async () => {
		globalThis.fetch = async () => new Response(null, { status: 429 });

		await expect(
			apolloPeopleSearch.run({ person_seniorities: ["vp"] }, apolloEnv()),
		).rejects.toThrow(RetryableProviderError);
	});

	it("returns null on a 422 so the waterfall continues", async () => {
		globalThis.fetch = async () =>
			jsonResponse(422, { error: "unprocessable" });

		const result = await apolloPeopleSearch.run(
			{ person_seniorities: ["vp"] },
			apolloEnv(),
		);

		expect(result).toBeNull();
	});
});

describe("apollo source", () => {
	it("never sets a reveal flag and never calls the enrichment endpoints", () => {
		const compiled = apolloPeopleSearch.run.toString();
		expect(compiled).not.toContain("reveal_personal_emails");
		expect(compiled).not.toContain("reveal_phone_number");
		expect(compiled).not.toContain("people/match");
		expect(compiled).not.toContain("bulk_match");
	});
});

describe("the parser against a real Apollo response", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("reads a response whose phone flag is the string Apollo really sends", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify(apolloCapture), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		const result = await apolloPeopleSearch.run(
			{ q_organization_domains_list: ["voltasoftware.com"] },
			apolloEnv(),
		);

		expect(result).not.toBeNull();
		expect(result?.candidates.length).toBeGreaterThan(0);
	});

	it("reads that string flag as a person who has a phone", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify(apolloCapture), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		const result = await apolloPeopleSearch.run(
			{ q_organization_domains_list: ["voltasoftware.com"] },
			apolloEnv(),
		);

		expect(result?.candidates[0]?.hasDirectPhone).toBe(true);
	});
});
