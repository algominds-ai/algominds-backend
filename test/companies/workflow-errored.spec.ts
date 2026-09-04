import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import { createIcp, findRun } from "@/core/db/queries";
import { icp as icpTable, run } from "@/core/db/schema";
import type { Requirement } from "@/core/requirements";

const storedRequirements: Requirement[] = [
	{
		id: "r1",
		text: "the company fits the profile",
		kind: "hard",
		proof: "record",
		windowDays: null,
	},
];

async function seedRun(): Promise<{ organizationId: string; icpId: string }> {
	const org = await organizationForSlug(
		testEnv,
		`companies-close-errored-${crypto.randomUUID()}`,
		"close-errored",
	);
	const icpRow = await createIcp(testEnv, {
		description: "seed profile for the close-errored test",
		domain: `close-errored-${crypto.randomUUID()}.internal`,
		organizationId: org.id,
		requirements: storedRequirements,
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
