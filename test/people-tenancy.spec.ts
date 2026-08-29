import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { organization } from "../src/core/db/auth-schema";
import { db } from "../src/core/db/client";
import { companiesForDomains } from "../src/core/db/company-domains";
import { organizationForSlug } from "../src/core/db/organizations";
import {
	createIcp,
	openRun,
	saveCompanies,
	savePeople,
} from "../src/core/db/queries";
import { company, icp as icpTable, person, run } from "../src/core/db/schema";
import { domainsScopeId } from "../src/http/jobs";

type SeededOrg = {
	organizationId: string;
	icpId: string;
	runId: string;
	companyId: string;
};

async function seedOrgWithCompany(
	label: string,
	domain: string,
): Promise<SeededOrg> {
	const org = await organizationForSlug(
		testEnv,
		`people-tenancy-${label}-${crypto.randomUUID()}.internal`,
		`people-tenancy-${label}`,
	);
	const icpRow = await createIcp(testEnv, {
		description: "seed icp for people tenancy tests",
		domain: org.slug,
		organizationId: org.id,
	});
	const runId = `companies_${label}-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: org.id,
		icpId: icpRow.id,
		capability: "companies",
		status: "complete",
	});
	const [savedCompany] = await saveCompanies(testEnv, [
		{ icpId: icpRow.id, runId, domain, name: `${label} Co` },
	]);
	if (!savedCompany) {
		throw new Error(`seedOrgWithCompany: failed to save company for ${label}`);
	}
	return {
		organizationId: org.id,
		icpId: icpRow.id,
		runId,
		companyId: savedCompany.id,
	};
}

async function cleanupOrg(seed: SeededOrg): Promise<void> {
	const connection = db(testEnv, "direct");
	await connection.delete(company).where(eq(company.runId, seed.runId));
	await connection.delete(run).where(eq(run.id, seed.runId));
	await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
	await connection
		.delete(organization)
		.where(eq(organization.id, seed.organizationId));
}

describe("companiesForDomains: tenancy", () => {
	it("returns nothing for a domain owned by another organization, and the row for the caller's own organization", async () => {
		const sharedDomain = `shared-${crypto.randomUUID()}.com`;
		const orgA = await seedOrgWithCompany("domain-scope-a", sharedDomain);
		const orgB = await seedOrgWithCompany("domain-scope-b", sharedDomain);

		try {
			const forOrgA = await companiesForDomains(
				testEnv,
				[sharedDomain],
				orgA.organizationId,
			);
			const forOrgB = await companiesForDomains(
				testEnv,
				[sharedDomain],
				orgB.organizationId,
			);
			const forStranger = await companiesForDomains(
				testEnv,
				[sharedDomain],
				crypto.randomUUID(),
			);

			expect(forOrgA.map((row) => row.icpId)).toEqual([orgA.icpId]);
			expect(forOrgB.map((row) => row.icpId)).toEqual([orgB.icpId]);
			expect(forStranger).toEqual([]);
		} finally {
			await cleanupOrg(orgA);
			await cleanupOrg(orgB);
		}
	});
});

describe("savePeople: tenancy", () => {
	it("keeps a row for each organization that finds the same linkedin url, and dedupes it within one organization", async () => {
		const linkedinUrl = `https://linkedin.com/in/shared-${crypto.randomUUID()}`;
		const orgA = await seedOrgWithCompany(
			"person-scope-a",
			`person-a-${crypto.randomUUID()}.com`,
		);
		const orgB = await seedOrgWithCompany(
			"person-scope-b",
			`person-b-${crypto.randomUUID()}.com`,
		);

		try {
			const savedA = await savePeople(testEnv, [
				{
					organizationId: orgA.organizationId,
					companyId: orgA.companyId,
					linkedinUrl,
					name: "Same Person",
				},
			]);
			const savedB = await savePeople(testEnv, [
				{
					organizationId: orgB.organizationId,
					companyId: orgB.companyId,
					linkedinUrl,
					name: "Same Person",
				},
			]);
			const savedAAgain = await savePeople(testEnv, [
				{
					organizationId: orgA.organizationId,
					companyId: orgA.companyId,
					linkedinUrl,
					name: "Same Person",
				},
			]);

			expect(savedA).toHaveLength(1);
			expect(savedB).toHaveLength(1);
			expect(savedAAgain).toHaveLength(0);

			const stored = await db(testEnv, "direct")
				.select()
				.from(person)
				.where(eq(person.linkedinUrl, linkedinUrl));
			expect(stored.map((row) => row.organizationId).sort()).toEqual(
				[orgA.organizationId, orgB.organizationId].sort(),
			);
		} finally {
			await db(testEnv, "direct")
				.delete(person)
				.where(eq(person.linkedinUrl, linkedinUrl));
			await cleanupOrg(orgA);
			await cleanupOrg(orgB);
		}
	});
});

describe("domainsScopeId: tenancy", () => {
	it("gives two organizations different scope ids for the same domain list on the same day", async () => {
		const domains = [
			`a-${crypto.randomUUID()}.com`,
			`b-${crypto.randomUUID()}.com`,
		];
		const orgA = crypto.randomUUID();
		const orgB = crypto.randomUUID();

		const scopeIdA = await domainsScopeId(domains, orgA);
		const scopeIdB = await domainsScopeId(domains, orgB);

		expect(scopeIdA).not.toBe(scopeIdB);
		expect(scopeIdA.startsWith("dom-")).toBe(true);
		expect(scopeIdB.startsWith("dom-")).toBe(true);
	});

	it("keeps giving the same organization the same scope id for the same domain list", async () => {
		const domains = [`c-${crypto.randomUUID()}.com`];
		const org = crypto.randomUUID();

		const first = await domainsScopeId(domains, org);
		const second = await domainsScopeId(domains, org);

		expect(first).toBe(second);
	});
});

const MISMATCH_SCOPE = "people-tenancy-load-icp-mismatch";

async function terminateMismatchRun(): Promise<void> {
	const instance = await testEnv.FIND_PEOPLE.get(MISMATCH_SCOPE).catch(
		() => null,
	);
	await instance?.terminate().catch(() => undefined);
}

afterEach(terminateMismatchRun);

describe("FindPeopleWorkflow: an icp from another organization", () => {
	it("refuses to run when the resolved icp belongs to a different organization than the payload names", async () => {
		const victim = await seedOrgWithCompany(
			"load-icp-guard-victim",
			`victim-${crypto.randomUUID()}.com`,
		);
		const attackerOrganizationId = crypto.randomUUID();
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			MISMATCH_SCOPE,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies: [], icpId: victim.icpId, unknownDomains: [] },
				);
			});

			await testEnv.FIND_PEOPLE.create({
				id: MISMATCH_SCOPE,
				params: {
					runId: `companies_${MISMATCH_SCOPE}`,
					organizationId: attackerOrganizationId,
				},
			});
			await instance.waitForStatus("errored");
		} finally {
			await instance.dispose();
			await cleanupOrg(victim);
		}
	});
});
