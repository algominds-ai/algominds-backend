import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CostLedger } from "../src/core/cost";
import { resolveIdentity } from "../src/core/people/identity";

function clayEnv(): Env {
	return { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const CreateRequestSchema = z.object({
	filters: z.object({
		company_identifier: z.array(z.string()),
		job_title_seniority_levels_v2: z.array(z.string()).optional(),
	}),
});

type CreateRequest = z.infer<typeof CreateRequestSchema>;

function isCreateCall(input: unknown): boolean {
	return new URL(String(input)).pathname === "/public/v0/search/filters-mode";
}

function stubClaySequence(responses: Response[]): {
	calls: number;
	creates: CreateRequest[];
} {
	const state: { calls: number; creates: CreateRequest[] } = {
		calls: 0,
		creates: [],
	};
	let step = 0;
	globalThis.fetch = async (input, init) => {
		state.calls += 1;
		if (isCreateCall(input)) {
			state.creates.push(
				CreateRequestSchema.parse(JSON.parse(String(init?.body))),
			);
		}
		const current = responses[step] ?? responses[responses.length - 1];
		step += 1;
		return current ?? new Response(null, { status: 404 });
	};
	return state;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const harborRow = {
	name: "Devon Ashworth",
	url: "https://www.linkedin.com/in/devonashworth",
	latest_experience_title: "Chief Revenue Officer",
	latest_experience_company: "Harbor Robotics",
	latest_experience_start_date: "2020-11-15",
	location: "Remote",
};

describe("identity resolution", () => {
	it("falls back from domain identity to the stored company URL", async () => {
		const fromDomain = stubClaySequence([
			jsonResponse(200, { search_id: "domain-search" }),
			jsonResponse(200, { data: [], has_more: false }),
			jsonResponse(200, { search_id: "linkedin-search" }),
			jsonResponse(200, { data: [harborRow], has_more: false }),
		]);

		const linkedinUrl = "https://www.linkedin.com/company/harbor-robotics";
		const found = await resolveIdentity(
			{ domain: "harbormsp.com", linkedinUrl },
			clayEnv(),
			new CostLedger(),
		);

		expect(found.how).toBe("linkedin");
		if (found.how === "linkedin") {
			expect(found.identifier).toBe(linkedinUrl);
			expect(found.name).toBe("Harbor Robotics");
		}
		expect(fromDomain.calls).toBe(4);
		expect(fromDomain.creates).toEqual([
			{
				filters: {
					company_identifier: ["harbormsp.com"],
					job_title_seniority_levels_v2: ["c-suite"],
				},
			},
			{
				filters: {
					company_identifier: [linkedinUrl],
					job_title_seniority_levels_v2: ["c-suite"],
				},
			},
		]);

		const bothEmpty = stubClaySequence([
			jsonResponse(200, { search_id: "domain-search-2" }),
			jsonResponse(200, { data: [], has_more: false }),
			jsonResponse(200, { search_id: "linkedin-search-2" }),
			jsonResponse(200, { data: [], has_more: false }),
		]);

		const unresolved = await resolveIdentity(
			{ domain: "harbormsp.com", linkedinUrl },
			clayEnv(),
			new CostLedger(),
		);

		expect(unresolved.how).toBe("unresolved");
		expect(bothEmpty.calls).toBe(4);
	});

	it("stays unresolved with no further call when there is no stored linkedin url", async () => {
		const calls = stubClaySequence([
			jsonResponse(200, { search_id: "domain-search" }),
			jsonResponse(200, { data: [], has_more: false }),
		]);

		const result = await resolveIdentity(
			{ domain: "harbormsp.com", linkedinUrl: null },
			clayEnv(),
			new CostLedger(),
		);

		expect(result.how).toBe("unresolved");
		expect(calls.calls).toBe(2);
	});

	it("resolves a Clay-rejected domain to unresolved with no roster call", async () => {
		const calls = stubClaySequence([
			jsonResponse(200, { search_id: "domain-search" }),
			jsonResponse(400, { error: "invalid company_identifier" }),
		]);

		const result = await resolveIdentity(
			{ domain: "notacompany.example", linkedinUrl: null },
			clayEnv(),
			new CostLedger(),
		);

		expect(result.how).toBe("unresolved");
		expect(calls.calls).toBe(2);
	});
});
