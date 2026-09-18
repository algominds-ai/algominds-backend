import { afterEach, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import { canonicalPersonUrl, claySearch } from "@/core/providers/clay";
import { cancelAgentRun, startAgentRun } from "@/core/providers/exa/agent";
import { exaPeopleRoster } from "@/core/providers/exa/people-roster";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, respondOnce, stubClaySequence } from "../support/fetch";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

it("validates the actual LinkedIn hostname and preserves agent input data", async () => {
	expect(
		canonicalPersonUrl("https://linkedin.com.evil.test/in/alex"),
	).toBeNull();
	expect(
		canonicalPersonUrl("https://evil.test/linkedin.com/in/alex"),
	).toBeNull();
	expect(
		canonicalPersonUrl("https://www.linkedin.com@evil.test/in/alex"),
	).toBeNull();
	const response = respondOnce(
		jsonResponse({ id: "batch-one", status: "running" }),
	);
	globalThis.fetch = response.fetch;
	await startAgentRun(
		{
			query: "Research supplied people",
			effort: "medium",
			input: { data: [{ id: 7, name: "Alex" }] },
			outputSchema: { type: "object" },
		},
		fakeSecretEnv({ EXA_API_KEY: "test" }),
	);
	expect(JSON.parse(String(response.calls[0]?.init?.body)).input.data).toEqual([
		{ id: 7, name: "Alex" },
	]);
});

it("maps Clay's matching employer job rather than an unrelated latest job and reports truncation", async () => {
	stubClaySequence([
		{ response: jsonResponse({ search_id: "one" }) },
		{
			response: jsonResponse({
				data: [
					{
						name: "Alex",
						url: "https://linkedin.com/in/alex",
						latest_experience_title: "Advisor",
						latest_experience_company: "Unrelated",
						matched_experience: {
							job_title: "Founder",
							company_name: "Exact",
							start_date: "2020",
						},
					},
				],
				has_more: false,
			}),
		},
	]);
	const result = await claySearch(
		fakeSecretEnv({ CLAY_API_KEY: "test" }),
		{ identifier: "exact.example" },
		new CostLedger(),
	);
	expect(result.rows[0]).toMatchObject({
		title: "Founder",
		company: "Exact",
		since: "2020",
	});
	expect(result.capped).toBe(false);
});

const concurrentJobs = {
	requestId: "one",
	costDollars: { total: 0.005 },
	results: [
		{
			url: "https://linkedin.com/in/alex",
			title: "Alex",
			entities: [
				{
					type: "person",
					properties: {
						name: "Alex",
						workHistory: [
							{
								title: "Advisor",
								dates: { to: null },
								company: { id: "other", name: "Other" },
							},
							{
								title: "CTO",
								dates: { to: null },
								company: { id: "exact", name: "Exact" },
							},
							{
								title: "Founder",
								dates: { to: null },
								company: { id: "exact", name: "Exact" },
							},
						],
					},
				},
			],
		},
	],
};

it("finds the exact employer among concurrent current jobs and keeps their combined responsibilities", async () => {
	globalThis.fetch = async () => jsonResponse(concurrentJobs);
	const result = await exaPeopleRoster(
		fakeSecretEnv({ EXA_API_KEY: "test" }),
		{
			domain: "exact.example",
			name: "Exact",
			linkedinUrl: null,
		},
		"exact",
		new CostLedger(),
	);
	expect(result.rows[0]?.title).toBe("CTO; Founder");
});

it("does not convert unknown terminal agent billing to a zero fee", async () => {
	globalThis.fetch = async () =>
		jsonResponse({ id: "one", status: "canceled" });
	const result = await cancelAgentRun(
		"one",
		fakeSecretEnv({ EXA_API_KEY: "test" }),
	);
	expect(result).toEqual({
		status: "canceled",
		terminal: true,
		costDollars: null,
	});
});

it("retains Clay rows and consumed quota when a later page fails", async () => {
	stubClaySequence([
		{ response: jsonResponse({ search_id: "partial" }) },
		{
			response: jsonResponse({
				data: [{ name: "Alex", url: "https://linkedin.com/in/alex" }],
				has_more: true,
			}),
		},
		{ response: jsonResponse({ error: "Provider unavailable" }, 500) },
	]);
	const result = await claySearch(
		fakeSecretEnv({ CLAY_API_KEY: "test" }),
		{ identifier: "example.com" },
		new CostLedger(),
	);
	expect(result.rows).toHaveLength(1);
	expect(result.quotaUsed).toBe(1);
	expect(result.capped).toBe(true);
	expect(result.error).toContain("status 500");
});
