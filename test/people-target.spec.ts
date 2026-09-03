import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { organization } from "../src/core/db/auth-schema";
import { db, withConnection } from "../src/core/db/client";
import { organizationForSlug } from "../src/core/db/organizations";
import { createIcp, openRun, saveCompanies } from "../src/core/db/queries";
import { company, icp as icpTable, run } from "../src/core/db/schema";
import { loadTargetCompanies } from "../src/workflows/find-people-target";

type SeededRun = {
	icpId: string;
	runId: string;
};

async function seedIcpAndRun(
	label: string,
	organizationId: string,
): Promise<SeededRun> {
	const icpRow = await createIcp(testEnv, {
		description: "seed icp for people target tests",
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

const seededOrgIds: string[] = [];
const seededRuns: SeededRun[] = [];

async function cleanupOrg(organizationId: string): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(company)
			.where(eq(company.organizationId, organizationId));
		for (const seed of seededRuns) {
			await connection.delete(run).where(eq(run.id, seed.runId));
			await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		}
		await connection
			.delete(organization)
			.where(eq(organization.id, organizationId));
	});
}

afterEach(async () => {
	while (seededOrgIds.length > 0) {
		const organizationId = seededOrgIds.pop();
		if (organizationId) await cleanupOrg(organizationId);
	}
	seededRuns.length = 0;
});

describe("loadTargetCompanies: tenancy", () => {
	it("throws for a runId owned by another organization", async () => {
		const org = await organizationForSlug(
			testEnv,
			`people-target-run-tenancy-${crypto.randomUUID()}.internal`,
			"people-target-run-tenancy",
		);
		seededOrgIds.push(org.id);
		const seed = await seedIcpAndRun("run-tenancy", org.id);
		seededRuns.push(seed);

		await expect(
			loadTargetCompanies(testEnv, {
				runId: seed.runId,
				organizationId: crypto.randomUUID(),
			}),
		).rejects.toBeInstanceOf(NonRetryableError);
	});

	it("throws for an explicit icpId owned by another organization", async () => {
		const owner = await organizationForSlug(
			testEnv,
			`people-target-icp-tenancy-owner-${crypto.randomUUID()}.internal`,
			"people-target-icp-tenancy-owner",
		);
		seededOrgIds.push(owner.id);
		const seed = await seedIcpAndRun("icp-tenancy", owner.id);
		seededRuns.push(seed);
		const stranger = await organizationForSlug(
			testEnv,
			`people-target-icp-tenancy-stranger-${crypto.randomUUID()}.internal`,
			"people-target-icp-tenancy-stranger",
		);
		seededOrgIds.push(stranger.id);

		await expect(
			loadTargetCompanies(testEnv, {
				domains: [`unused-${crypto.randomUUID()}.com`],
				organizationId: stranger.id,
				icpId: seed.icpId,
			}),
		).rejects.toBeInstanceOf(NonRetryableError);
	});
});

describe("loadTargetCompanies: domain resolution with no icpId given", () => {
	it("falls back to a null profile when the domain matches two different profiles", async () => {
		const org = await organizationForSlug(
			testEnv,
			`people-target-ambiguous-${crypto.randomUUID()}.internal`,
			"people-target-ambiguous",
		);
		seededOrgIds.push(org.id);
		const domain = `ambiguous-${crypto.randomUUID()}.com`;
		const first = await seedIcpAndRun("ambiguous-a", org.id);
		const second = await seedIcpAndRun("ambiguous-b", org.id);
		seededRuns.push(first, second);
		await saveCompanies(testEnv, [
			{
				icpId: first.icpId,
				organizationId: org.id,
				runId: first.runId,
				domain,
				name: "Ambiguous Co A",
			},
			{
				icpId: second.icpId,
				organizationId: org.id,
				runId: second.runId,
				domain,
				name: "Ambiguous Co B",
			},
		]);

		const target = await loadTargetCompanies(testEnv, {
			domains: [domain],
			organizationId: org.id,
		});

		expect(target.icpId).toBeNull();
		expect(target.companies).toEqual([
			{ id: null, domain, name: null, linkedinUrl: null, icpId: null },
		]);
	});

	it("returns a null-id company for a domain that matches nothing", async () => {
		const org = await organizationForSlug(
			testEnv,
			`people-target-unmatched-${crypto.randomUUID()}.internal`,
			"people-target-unmatched",
		);
		seededOrgIds.push(org.id);
		const domain = `unmatched-${crypto.randomUUID()}.com`;

		const target = await loadTargetCompanies(testEnv, {
			domains: [domain],
			organizationId: org.id,
		});

		expect(target.icpId).toBeNull();
		expect(target.companies).toEqual([
			{ id: null, domain, name: null, linkedinUrl: null, icpId: null },
		]);
	});
});
