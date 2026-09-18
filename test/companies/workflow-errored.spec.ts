import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import { createIcp, findRun, loadIcp } from "@/core/db/queries";
import { icp as icpTable, run } from "@/core/db/schema";
import { IcpDocSchema } from "@/core/icp";
import { profileFixture, requirementFixture } from "../support/icp";

const storedRequirements = [requirementFixture("the company fits the profile")];

async function seedRun(
	extracted = true,
): Promise<{ organizationId: string; icpId: string }> {
	const org = await organizationForSlug(
		testEnv,
		`companies-close-errored-${crypto.randomUUID()}`,
		"close-errored",
	);
	const domain = `close-errored-${crypto.randomUUID()}.internal`;
	const icpRow = await createIcp(testEnv, {
		domain,
		organizationId: org.id,
		doc: {
			...profileFixture(
				{ requirements: storedRequirements },
				"seed profile for the close-errored test",
				domain,
			),
			extracted,
		},
	});
	return { organizationId: org.id, icpId: icpRow.id };
}

async function cleanup(
	seed: { organizationId: string; icpId: string },
	instanceId: string,
): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(run).where(eq(run.id, instanceId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		await connection
			.delete(organization)
			.where(eq(organization.id, seed.organizationId));
	});
}

describe("a step failure closes the run row, instead of leaving it running forever", () => {
	it("persists a free-text extraction and banks its spend before discovery fails", async () => {
		const seed = await seedRun(false);
		const draft = await loadIcp(testEnv, seed.icpId);
		const profile = { ...IcpDocSchema.parse(draft?.doc), extracted: true };
		const instanceId = `companies_extraction_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "extract-profile" },
					{ value: profile, costDollars: 0.07, error: null },
				);
				await m.mockStepError(
					{ name: "round_1" },
					new NonRetryableError("discovery unavailable"),
				);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 5 },
			});
			await instance.waitForStatus("errored");
			expect((await loadIcp(testEnv, seed.icpId))?.doc).toEqual(profile);
			expect(await findRun(testEnv, instanceId)).toMatchObject({
				status: "errored",
				costDollars: 0.07,
			});
		} finally {
			await instance.dispose();
			await cleanup(seed, instanceId);
		}
	});
	it("leaves the run row errored, with finished_at set", async () => {
		const seed = await seedRun();
		const instanceId = `companies_close_errored_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepError(
					{ name: "round_1" },
					new NonRetryableError("a step failure must close the run"),
				);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 5 },
			});
			await instance.waitForStatus("errored");

			const row = await findRun(testEnv, instanceId);
			expect(row?.status).toBe("errored");
			expect(row?.finishedAt).toBeInstanceOf(Date);
		} finally {
			await instance.dispose();
			await cleanup(seed, instanceId);
		}
	});
});
