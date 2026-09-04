import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import { resolveIdentity } from "@/core/people/identity";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, stubClaySequence } from "../support/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function clayEnv(): Env {
	return fakeSecretEnv({ CLAY_API_KEY: "test-clay-key" });
}

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
			jsonResponse({ search_id: "domain-search" }),
			jsonResponse({ data: [], has_more: false }),
			jsonResponse({ search_id: "linkedin-search" }),
			jsonResponse({ data: [harborRow], has_more: false }),
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
		expect(fromDomain.creates.map((f) => f.company_identifier)).toEqual([
			["harbormsp.com"],
			[linkedinUrl],
		]);
	});

	it("stays unresolved with no further call when there is no stored linkedin url", async () => {
		const calls = stubClaySequence([
			jsonResponse({ search_id: "domain-search" }),
			jsonResponse({ data: [], has_more: false }),
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
			jsonResponse({ search_id: "domain-search" }),
			jsonResponse({ error: "invalid company_identifier" }, 400),
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
