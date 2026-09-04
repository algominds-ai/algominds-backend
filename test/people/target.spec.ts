import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { createIcp, openRun, saveCompanies } from "@/core/db/queries";
import { company, icp as icpTable, run } from "@/core/db/schema";
import { loadTargetCompanies } from "@/workflows/find-people-target";
import { seedOrganization } from "../support/db";

type SeededRun = { icpId: string; runId: string };

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

afterEach(async () => {
	await withConnection(testEnv, "direct", db, async (connection) => {
		for (const seed of seededRuns) {
			await connection.delete(company).where(eq(company.runId, seed.runId));
			await connection.delete(run).where(eq(run.id, seed.runId));
			await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		}
		for (const organizationId of seededOrgIds) {
			await connection
				.delete(organization)
				.where(eq(organization.id, organizationId));
		}
	});
	seededOrgIds.length = 0;
	seededRuns.length = 0;
});

describe("loadTargetCompanies: domain resolution with no icpId given", () => {
	it("falls back to a null profile when the domain matches two different profiles", async () => {
		const org = await seedOrganization("people-target-ambiguous");
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
		const org = await seedOrganization("people-target-unmatched");
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
