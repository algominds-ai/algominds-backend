import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { companiesForDomains } from "@/core/db/company-domains";
import {
	createIcp,
	findRun,
	openRun,
	saveCompanies,
	upsertPeople,
} from "@/core/db/queries";
import { company, icp as icpTable, person, run } from "@/core/db/schema";
import { domainsScopeId } from "@/http/jobs";
import { loadTargetCompanies } from "@/workflows/find-people-target";
import { seedOrganization } from "../support/db";
import { companyRowsFor, personRowsFor } from "./support";

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
	const org = await seedOrganization(`people-tenancy-${label}`);
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
		{
			icpId: icpRow.id,
			organizationId: org.id,
			runId,
			domain,
			name: `${label} Co`,
		},
	]);
	if (!savedCompany) throw new Error(`failed to save company for ${label}`);
	return {
		organizationId: org.id,
		icpId: icpRow.id,
		runId,
		companyId: savedCompany.id,
	};
}

async function cleanupOrg(seed: SeededOrg): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(company).where(eq(company.runId, seed.runId));
		await connection.delete(run).where(eq(run.id, seed.runId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		await connection
			.delete(organization)
			.where(eq(organization.id, seed.organizationId));
	});
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

function personPayload(seed: SeededOrg, linkedinUrl: string) {
	return {
		organizationId: seed.organizationId,
		companyId: seed.companyId,
		linkedinUrl,
		name: "Same Person",
	};
}

describe("upsertPeople: tenancy", () => {
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
			const personA = personPayload(orgA, linkedinUrl);
			const savedA = await upsertPeople(testEnv, [personA]);
			const savedB = await upsertPeople(testEnv, [
				personPayload(orgB, linkedinUrl),
			]);
			const savedAAgain = await upsertPeople(testEnv, [personA]);

			expect(savedA).toHaveLength(1);
			expect(savedB).toHaveLength(1);
			expect(savedAAgain).toHaveLength(1);

			const stored = await withConnection(testEnv, "direct", db, (connection) =>
				connection
					.select()
					.from(person)
					.where(eq(person.linkedinUrl, linkedinUrl)),
			);
			expect(stored.map((row) => row.organizationId).sort()).toEqual(
				[orgA.organizationId, orgB.organizationId].sort(),
			);
		} finally {
			await withConnection(testEnv, "direct", db, (connection) =>
				connection.delete(person).where(eq(person.linkedinUrl, linkedinUrl)),
			);
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
		const scopeIdA = await domainsScopeId(domains, crypto.randomUUID());
		const scopeIdB = await domainsScopeId(domains, crypto.randomUUID());

		expect(scopeIdA).not.toBe(scopeIdB);
		expect(scopeIdA.startsWith("dom-")).toBe(true);
		expect(scopeIdB.startsWith("dom-")).toBe(true);
	});

	it("keeps giving the same organization the same scope id for the same domain list", async () => {
		const domains = [`c-${crypto.randomUUID()}.com`];
		const org = crypto.randomUUID();

		expect(await domainsScopeId(domains, org)).toBe(
			await domainsScopeId(domains, org),
		);
	});
});

async function seedIcpAndRun(label: string, organizationId: string) {
	const icpRow = await createIcp(testEnv, {
		description: "seed icp for people target tenancy",
		domain: `${label}-${crypto.randomUUID()}.internal`,
		organizationId,
	});
	const runId = `companies_${label}-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId,
		icpId: icpRow.id,
		capability: "companies",
		status: "complete",
	});
	return { icpId: icpRow.id, runId };
}

describe("loadTargetCompanies: tenancy", () => {
	it("throws for a runId owned by another organization", async () => {
		const org = await seedOrganization("people-target-run-tenancy");
		const seed = await seedIcpAndRun("run-tenancy", org.id);
		try {
			await expect(
				loadTargetCompanies(testEnv, {
					runId: seed.runId,
					organizationId: crypto.randomUUID(),
				}),
			).rejects.toBeInstanceOf(NonRetryableError);
		} finally {
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection.delete(run).where(eq(run.id, seed.runId));
				await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
				await connection
					.delete(organization)
					.where(eq(organization.id, org.id));
			});
		}
	});

	it("throws for an explicit icpId owned by another organization", async () => {
		const owner = await seedOrganization("people-target-icp-tenancy-owner");
		const seed = await seedIcpAndRun("icp-tenancy", owner.id);
		const stranger = await seedOrganization(
			"people-target-icp-tenancy-stranger",
		);
		try {
			await expect(
				loadTargetCompanies(testEnv, {
					domains: [`unused-${crypto.randomUUID()}.com`],
					organizationId: stranger.id,
					icpId: seed.icpId,
				}),
			).rejects.toBeInstanceOf(NonRetryableError);
		} finally {
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection.delete(run).where(eq(run.id, seed.runId));
				await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
				await connection
					.delete(organization)
					.where(eq(organization.id, owner.id));
				await connection
					.delete(organization)
					.where(eq(organization.id, stranger.id));
			});
		}
	});
});

const MISMATCH_SCOPE = "people-tenancy-load-icp-mismatch";

afterEach(async () => {
	const instance = await testEnv.FIND_PEOPLE.get(MISMATCH_SCOPE).catch(
		() => null,
	);
	await instance?.terminate().catch(() => undefined);
});

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

			expect(await findRun(testEnv, MISMATCH_SCOPE)).toBeUndefined();
			expect(await companyRowsFor(attackerOrganizationId)).toHaveLength(0);
			expect(await personRowsFor(attackerOrganizationId)).toHaveLength(0);
		} finally {
			await instance.dispose();
			await cleanupOrg(victim);
		}
	});
});
