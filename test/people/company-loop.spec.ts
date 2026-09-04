import { describe, expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import type { CompanyLoopContext } from "@/workflows/find-people-company";
import { runCompanies, runOneCompany } from "@/workflows/find-people-company";
import { rescueUnresolved } from "@/workflows/find-people-rescue";
import { fakeSecretEnv } from "../support/env";
import {
	exaPeopleSearchResponse,
	fakeVendors,
	jsonResponse,
	stubClayRejectFetch,
	stubGetleadsFetch,
} from "../support/fetch";
import { fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	cleanupPeopleRun,
	companyRowsFor,
	evidenceRowsFor,
	runCompanyRowsFor,
	type SeededPeopleRun,
	seedPeopleRun,
} from "./support";

function contextFor(
	seed: SeededPeopleRun,
	overrides: Map<string, unknown>,
): CompanyLoopContext {
	return {
		env: fakeSecretEnv({ CLAY_API_KEY: "test-clay-key" }),
		step: fakeWorkflowStep(overrides).step,
		runId: seed.runId,
		organizationId: seed.org.id,
		buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
		profile: null,
	};
}

describe("runOneCompany: an unresolved domain's Clay spend", () => {
	it("banks the identity step's clay records and spend on the run_company row", async () => {
		const domain = `unresolved-spend-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("unresolved-spend");
		try {
			const overrides = new Map<string, unknown>([
				[
					`people-${domain}-identity`,
					{
						how: "unresolved",
						clayRecords: 7,
						costEntries: [{ provider: "clay", op: "search", dollars: 0.03 }],
					},
				],
				[`people-${domain}-rescue`, null],
			]);

			const result = await runOneCompany(
				contextFor(seed, overrides),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.unresolvedDomain).toBe(domain);
			expect(result.costDollars).toBeCloseTo(0.03);
			const rows = await runCompanyRowsFor(seed.runId);
			expect(rows[0]?.clayRecords).toBe(7);
			expect(rows[0]?.spendDollars).toBeCloseTo(0.03);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

describe("FindPeopleWorkflow: a Clay-rejected domain", () => {
	it("writes identity: unresolved and lists the domain as unknown, with no roster call", async () => {
		const domain = "notacompany.example";
		const seed = await seedPeopleRun("reject");
		try {
			const calls = stubClayRejectFetch();

			const result = await runCompanies(
				contextFor(seed, new Map()),
				[bareCompany(domain)],
				0,
			);

			expect(result.unknownDomains).toEqual([domain]);
			expect(result.peopleVerified).toBe(0);
			expect(result.peopleRoster).toBe(0);
			expect(calls.runCalls).toBe(1);

			const runCompanyRows = await runCompanyRowsFor(seed.runId);
			expect(runCompanyRows[0]?.identity).toBe("unresolved");
			expect(runCompanyRows[0]?.companyId).toBeNull();
			expect(await companyRowsFor(seed.org.id)).toHaveLength(0);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

const STEVE = {
	first_name: "Steve",
	last_name: "Apostolopoulos",
	job_title: "Co Founder and President",
	person_linkedin_url: "https://www.linkedin.com/in/steve-a",
	person_city: "Toronto",
	person_country_name: "Canada",
};

async function rescue(seed: SeededPeopleRun, domain: string) {
	const ctx: CompanyLoopContext = {
		...contextFor(seed, new Map()),
		env: fakeSecretEnv({
			GL_API_KEY: "test-gl-key",
			EXA_API_KEY: "test-exa-key",
		}),
	};
	return rescueUnresolved(ctx, bareCompany(domain), crypto.randomUUID(), {
		how: "unresolved",
		clayRecords: 2,
		costEntries: [],
	});
}

describe("a domain Clay cannot resolve is rescued from GetLeads", () => {
	const originalFetch = globalThis.fetch;

	it("returns the GetLeads decision makers as the roster", async () => {
		const seed = await seedPeopleRun("rescue");
		try {
			stubGetleadsFetch([STEVE]);
			const rescued = await rescue(seed, "caary.com");
			expect(rescued?.candidates.map((c) => c.name)).toEqual([
				"Steve Apostolopoulos",
			]);
			expect(rescued?.clayRecords).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
			await cleanupPeopleRun(seed);
		}
	});

	it("returns null when GetLeads and the Exa people index both hold nobody", async () => {
		const seed = await seedPeopleRun("rescue-nobody");
		try {
			globalThis.fetch = fakeVendors(
				{
					"/api/v1/contacts/lookup/decision-makers": () =>
						jsonResponse({ ok: "True", contacts: [], query_credits_used: "0" }),
				},
				{ "/search": () => exaPeopleSearchResponse([], 0) },
			);
			expect(await rescue(seed, "nobody.example")).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
			await cleanupPeopleRun(seed);
		}
	});
});

describe("one company's failure never ends the run", () => {
	it("records the failed company as run evidence, reports it unresolved, and runs the next company", async () => {
		const broken = `broken-${crypto.randomUUID()}.example`;
		const next = `next-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("skip-failed");
		try {
			const overrides = new Map<string, unknown>([
				[`people-${broken}-open`, new Error("Model call timed out twice")],
				[
					`people-${next}-identity`,
					{ how: "unresolved", clayRecords: 0, costEntries: [] },
				],
				[`people-${next}-rescue`, null],
			]);

			const result = await runCompanies(
				contextFor(seed, overrides),
				[bareCompany(broken), bareCompany(next)],
				0,
			);

			expect(result.companiesSearched).toBe(2);
			expect(result.unknownDomains).toEqual(
				expect.arrayContaining([broken, next]),
			);
			const evidence = await evidenceRowsFor(seed.runId);
			const failure = evidence.find((row) => row.kind === "company-error");
			expect(failure?.value).toContain(broken);
			expect(failure?.value).toContain("Model call timed out twice");
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
