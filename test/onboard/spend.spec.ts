import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withConnection } from "@/core/db/client";
import { saveOnboardedIcp } from "@/core/db/icp";
import { organizationForSlug } from "@/core/db/organizations";
import { findRun, loadIcp, openRun } from "@/core/db/queries";
import { organizationSpendToday } from "@/core/db/runs";
import { icp as icpTable, run } from "@/core/db/schema";
import { ONBOARD_STEPS } from "@/workflows/onboard-icp";
import { profileFixture } from "../support/icp";
import { primeOnboardProfile } from "./fixtures";

async function deleteIcpAndRun(runId: string): Promise<void> {
	const runRow = await findRun(testEnv, runId);
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(run).where(eq(run.id, runId));
		if (runRow?.icpId)
			await connection.delete(icpTable).where(eq(icpTable.id, runRow.icpId));
	});
}

async function failWriteProfile(
	instance: Awaited<ReturnType<typeof introspectWorkflowInstance>>,
	domain: string,
	costDollars: number,
): Promise<void> {
	await instance.modify(async (m) => {
		await m.mockStepResult(
			{ name: ONBOARD_STEPS.readSeller },
			{
				value: [{ url: `https://${domain}/`, text: "" }],
				costDollars,
				error: null,
			},
		);
		await m.mockStepError(
			{ name: ONBOARD_STEPS.writeProfile },
			new NonRetryableError("the model was unreachable"),
		);
	});
}

describe("OnboardIcpWorkflow: what a run that dies keeps and adds", () => {
	it("keeps what a run spent before failing, and adds to it rather than replacing it on the next attempt", async () => {
		const org = await organizationForSlug(
			testEnv,
			`onboard-banked-${crypto.randomUUID()}.internal`,
			"onboard-banked",
		);
		const runId = `onboarding_banked-${crypto.randomUUID()}`;
		const domain = `banked-${crypto.randomUUID()}.example`;
		const params = { domain, note: null, organizationId: org.id };

		const first = await introspectWorkflowInstance(testEnv.ONBOARD_ICP, runId);
		try {
			await failWriteProfile(first, domain, 0.04);
			await testEnv.ONBOARD_ICP.create({ id: runId, params });
			await first.waitForStatus("errored");
			expect((await findRun(testEnv, runId))?.costDollars).toBe(0.04);
			expect((await findRun(testEnv, runId))?.status).toBe("errored");
		} finally {
			await first.dispose();
		}

		const second = await introspectWorkflowInstance(testEnv.ONBOARD_ICP, runId);
		try {
			await primeOnboardProfile(second, domain, { costDollars: 0.02 });
			await testEnv.ONBOARD_ICP.create({ id: runId, params });
			await second.waitForStatus("complete");

			expect((await findRun(testEnv, runId))?.costDollars).toBeCloseTo(0.07, 5);
			expect(await organizationSpendToday(testEnv, org.id)).toBeCloseTo(
				0.07,
				5,
			);
		} finally {
			await second.dispose();
			await deleteIcpAndRun(runId);
		}
	});
});

describe("OnboardIcpWorkflow: a model call that spends but writes no profile", () => {
	it("banks what the model cost before failing the run", async () => {
		const org = await organizationForSlug(
			testEnv,
			`onboard-noprofile-${crypto.randomUUID()}.internal`,
			"onboard-noprofile",
		);
		const runId = `onboarding_noprofile-${crypto.randomUUID()}`;
		const domain = `noprofile-${crypto.randomUUID()}.example`;
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			runId,
		);
		try {
			await primeOnboardProfile(instance, domain, {
				profile: null,
				costDollars: 0.02,
			});
			await testEnv.ONBOARD_ICP.create({
				id: runId,
				params: { domain, note: null, organizationId: org.id },
			});
			await instance.waitForStatus("errored");

			expect((await findRun(testEnv, runId))?.costDollars).toBeCloseTo(0.03, 5);
		} finally {
			await instance.dispose();
			await deleteIcpAndRun(runId);
		}
	});
});

describe("saveOnboardedIcp", () => {
	it("writes the profile and closes its run in one call", async () => {
		const org = await organizationForSlug(
			testEnv,
			`save-onboarded-${crypto.randomUUID()}.internal`,
			"save-onboarded",
		);
		const runId = `onboarding_save-${crypto.randomUUID()}`;
		await openRun(testEnv, {
			id: runId,
			organizationId: org.id,
			capability: "onboarding",
			status: "running",
		});

		const icpId = await saveOnboardedIcp(testEnv, {
			runId,
			domain: "acme.example",
			organizationId: org.id,
			doc: profileFixture({}, "a stored profile", "acme.example"),
			costDollars: 0.05,
		});

		const stored = await loadIcp(testEnv, icpId);
		const closed = await findRun(testEnv, runId);
		expect(stored?.doc).toEqual(
			profileFixture({}, "a stored profile", "acme.example"),
		);
		expect(closed?.icpId).toBe(icpId);
		expect(closed?.status).toBe("complete");
		expect(closed?.finishedAt).not.toBeNull();
		expect(
			await saveOnboardedIcp(testEnv, {
				runId,
				domain: "acme.example",
				organizationId: org.id,
				doc: profileFixture({}, "a stored profile", "acme.example"),
				costDollars: 0.05,
			}),
		).toBe(icpId);
	});
});
