import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { db, withConnection } from "../src/core/db/client";
import { organizationForSlug } from "../src/core/db/organizations";
import { closeRun, createIcp, findRun, openRun } from "../src/core/db/queries";
import { icp as icpTable, run } from "../src/core/db/schema";

type Seed = { organizationId: string; icpId: string; spentRunId: string };

async function seedOrganizationThatSpent(
	label: string,
	costDollars: number,
): Promise<Seed> {
	const organization = await organizationForSlug(
		testEnv,
		`spend-${label}-${crypto.randomUUID()}.internal`,
		`spend-${label}`,
	);
	const icpRow = await createIcp(testEnv, {
		description: "seed profile for spend ceiling tests",
		domain: organization.slug,
		organizationId: organization.id,
	});
	const spentRunId = `companies_${label}-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: spentRunId,
		organizationId: organization.id,
		icpId: icpRow.id,
		capability: "companies",
		status: "running",
	});
	await closeRun(testEnv, spentRunId, { status: "complete", costDollars });
	return {
		organizationId: organization.id,
		icpId: icpRow.id,
		spentRunId,
	};
}

async function cleanup(seed: Seed, startedRunId: string): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(run).where(eq(run.id, startedRunId));
		await connection.delete(run).where(eq(run.id, seed.spentRunId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
	});
}

const started: string[] = [];

afterEach(async () => {
	for (const id of started.splice(0)) {
		const instance = await testEnv.FIND_COMPANIES.get(id).catch(() => null);
		await instance?.terminate().catch(() => null);
	}
});

describe("the account's daily spend ceiling", () => {
	it("refuses a run for an account whose day already costs the ceiling", async () => {
		const seed = await seedOrganizationThatSpent(
			"over",
			config.spend.perAccountDailyDollars,
		);
		const instanceId = `companies_ceiling-over-${crypto.randomUUID()}`;
		started.push(instanceId);
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);

		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-icp" },
					{
						doc: {
							description: "anything",
							requirements: [
								{
									id: "r1",
									text: "the company fits the profile",
									kind: "hard",
									proof: "record",
									windowDays: null,
								},
							],
						},
						organizationId: seed.organizationId,
					},
				);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 1 },
			});
			await instance.waitForStatus("errored");

			expect(await findRun(testEnv, instanceId)).toBeUndefined();
		} finally {
			await cleanup(seed, instanceId);
		}
	});

	it("opens a run for an account still under the ceiling", async () => {
		const seed = await seedOrganizationThatSpent("under", 0.01);
		const instanceId = `companies_ceiling-under-${crypto.randomUUID()}`;
		started.push(instanceId);
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);

		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-icp" },
					{
						doc: {
							description: "anything",
							requirements: [
								{
									id: "r1",
									text: "the company fits the profile",
									kind: "hard",
									proof: "record",
									windowDays: null,
								},
							],
						},
						organizationId: seed.organizationId,
					},
				);
				await m.mockStepResult(
					{ name: "round_1" },
					{
						companies: [],
						requested: 1,
						found: 0,
						rounds: 1,
						status: "exhausted",
						costDollars: 0,
						rejects: [],
						searches: [],
						captures: {},
						seenDomains: [],
						feedback: [],
						pages: [],
					},
				);
				await m.mockStepResult({ name: "save-companies" }, {});
				await m.mockStepResult({ name: "close-run" }, {});
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 1 },
			});
			await instance.waitForStatus("complete");

			expect((await findRun(testEnv, instanceId))?.id).toBe(instanceId);
		} finally {
			await cleanup(seed, instanceId);
		}
	});
});
