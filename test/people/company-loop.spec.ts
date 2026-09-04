import { describe, expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import type { CompanyLoopContext } from "@/workflows/find-people-company";
import { runCompanies, runOneCompany } from "@/workflows/find-people-company";
import { fakeSecretEnv } from "../support/env";
import { stubClayRejectFetch } from "../support/fetch";
import { fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	cleanupPeopleRun,
	companyRowsFor,
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
			const overrides = new Map([
				[
					`people-${domain}-identity`,
					{
						how: "unresolved",
						clayRecords: 7,
						costEntries: [{ provider: "clay", op: "search", dollars: 0.03 }],
					},
				],
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
