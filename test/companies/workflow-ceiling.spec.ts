import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/config";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import { closeRun, createIcp, findRun, openRun } from "@/core/db/queries";
import { icp as icpTable, run as runTable } from "@/core/db/schema";

const started: string[] = [];

afterEach(async () => {
	for (const id of started.splice(0)) {
		const instance = await testEnv.FIND_COMPANIES.get(id).catch(() => null);
		await instance?.terminate().catch(() => null);
	}
});

async function seedRun(
	label: string,
): Promise<{ organizationId: string; icpId: string }> {
	const org = await organizationForSlug(
		testEnv,
		`companies-ceiling-${label}-${crypto.randomUUID()}`,
		label,
	);
	const icpRow = await createIcp(testEnv, {
		description: `seed profile for the ${label} test`,
		domain: `${label}-${crypto.randomUUID()}.internal`,
		organizationId: org.id,
	});
	return { organizationId: org.id, icpId: icpRow.id };
}

function loadIcpMock(organizationId: string) {
	return {
		doc: {
			description: "anything",
			requirements: [
				{
					id: "r1",
					text: "the company fits the profile",
					kind: "hard" as const,
					proof: "record" as const,
					windowDays: null,
				},
			],
		},
		organizationId,
	};
}

async function cleanup(
	seed: { organizationId: string; icpId: string },
	runIds: string[],
): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		for (const id of runIds) {
			await connection.delete(runTable).where(eq(runTable.id, id));
		}
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		await connection
			.delete(organization)
			.where(eq(organization.id, seed.organizationId));
	});
}

describe("the account's daily spend ceiling", () => {
	it("refuses a run for an account already at the ceiling", async () => {
		const seed = await seedRun("over");
		const spentRunId = `companies_pre-${crypto.randomUUID()}`;
		await openRun(testEnv, {
			id: spentRunId,
			organizationId: seed.organizationId,
			icpId: seed.icpId,
			capability: "companies",
			status: "running",
		}).then((row) =>
			closeRun(testEnv, row.id, {
				status: "complete",
				costDollars: config.spend.perAccountDailyDollars,
			}),
		);
		const instanceId = `companies_ceiling-over-${crypto.randomUUID()}`;
		started.push(instanceId);
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.mockStepResult(
				{ name: "load-icp" },
				loadIcpMock(seed.organizationId),
			);
		});

		await testEnv.FIND_COMPANIES.create({
			id: instanceId,
			params: { icpId: seed.icpId, count: 1 },
		});
		await instance.waitForStatus("errored");

		expect(await findRun(testEnv, instanceId)).toBeUndefined();
		await cleanup(seed, [spentRunId]);
	});

	it("opens a run for an account still under the ceiling", async () => {
		const seed = await seedRun("under");
		const instanceId = `companies_ceiling-under-${crypto.randomUUID()}`;
		started.push(instanceId);
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.mockStepResult(
				{ name: "load-icp" },
				loadIcpMock(seed.organizationId),
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
		await cleanup(seed, [instanceId]);
	});
});
