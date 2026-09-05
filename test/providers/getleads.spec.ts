import { afterEach, describe, expect, it } from "vitest";
import { getleadsDecisionMakers } from "@/core/providers/getleads";
import { RetryableProviderError } from "@/core/providers/waterfall";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse } from "../support/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("getleadsDecisionMakers", () => {
	it("turns each contact into a roster row with name, title, LinkedIn url and location, and reports the credits used", async () => {
		let body = "";
		globalThis.fetch = async (_input, init) => {
			body = String(init?.body);
			return jsonResponse({
				ok: "True",
				contacts: [
					{
						first_name: "Steve",
						last_name: "Apostolopoulos",
						job_title: "Co Founder and President",
						person_linkedin_url: "https://www.linkedin.com/in/steve-a",
						person_city: "Toronto",
						person_country_name: "Canada",
						org_company_name: "Caary Capital",
					},
				],
				query_credits_used: "1",
			});
		};

		const roster = await getleadsDecisionMakers(
			fakeSecretEnv({ GL_API_KEY: "test-gl-key" }),
			"caary.com",
		);

		expect(JSON.parse(body)).toEqual({ domain: "caary.com" });
		expect(roster.creditsUsed).toBe(1);
		expect(roster.rows).toEqual([
			{
				name: "Steve Apostolopoulos",
				title: "Co Founder and President",
				company: "Caary Capital",
				url: "https://www.linkedin.com/in/steve-a",
				location: "Toronto, Canada",
				since: null,
				source: "getleads:decision-makers",
			},
		]);
	});

	it("returns no rows, and spends nothing, for a domain it holds nobody for", async () => {
		globalThis.fetch = async () =>
			jsonResponse({ ok: "True", contacts: [], query_credits_used: "0" });

		const roster = await getleadsDecisionMakers(
			fakeSecretEnv({ GL_API_KEY: "test-gl-key" }),
			"nobody.example",
		);

		expect(roster.rows).toEqual([]);
		expect(roster.creditsUsed).toBe(0);
	});

	it("raises RetryableProviderError instead of a plain error when the fetch itself rejects", async () => {
		globalThis.fetch = async () => {
			throw new TypeError("fetch failed");
		};

		await expect(
			getleadsDecisionMakers(
				fakeSecretEnv({ GL_API_KEY: "test-gl-key" }),
				"caary.com",
			),
		).rejects.toThrow(RetryableProviderError);
	});
});
