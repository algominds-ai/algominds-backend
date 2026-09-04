import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "@/config";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import { closeRun, createIcp, findRun, openRun } from "@/core/db/queries";
import { icp as icpTable, run } from "@/core/db/schema";
import { NOTE_MAX_LENGTH } from "@/core/onboard";
import { buildRunId, onboardScopeId } from "@/http/jobs";
import app from "@/index";
import { publicHostname } from "@/workflows/onboard-icp";
import { issueOrganizationKey } from "../support/db";
import { primeOnboardProfile, primeOnboardStart } from "./fixtures";

const BASE = "https://onboard.test";

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

beforeAll(async () => {
	const issued = await issueOrganizationKey(
		`onboard-workflow-caller-${crypto.randomUUID()}`,
	);
	TOKEN = issued.key;
	CALLER_ORGANIZATION_ID = issued.organizationId;
});

async function authedCall(path: string, body: unknown): Promise<Response> {
	return app.fetch(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify(body),
		}),
		testEnv,
	);
}

async function deleteIcpAndRun(runId: string): Promise<void> {
	const runRow = await findRun(testEnv, runId);
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(run).where(eq(run.id, runId));
		if (runRow?.icpId)
			await connection.delete(icpTable).where(eq(icpTable.id, runRow.icpId));
	});
}

describe("POST /icp/onboard: validation", () => {
	it("rejects a body with no domain, a private hostname, or a note past the cap", async () => {
		const noDomain = await authedCall("/icp/onboard", {});
		const notPublic = await authedCall("/icp/onboard", { domain: "localhost" });
		const noteTooLong = await authedCall("/icp/onboard", {
			domain: "acme.example",
			note: "x".repeat(NOTE_MAX_LENGTH + 1),
		});

		expect(noDomain.status).toBe(400);
		expect(notPublic.status).toBe(400);
		expect(noteTooLong.status).toBe(400);
	});
});

describe("POST /icp/onboard: starts without waiting for the profile", () => {
	it("returns 202 with a runId built from the domain scope, well under the profile's own latency", async () => {
		const domain = `acme-${crypto.randomUUID()}.example`;
		const scopeId = await onboardScopeId({ domain }, CALLER_ORGANIZATION_ID);
		const runId = buildRunId("onboarding", scopeId);
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			runId,
		);
		try {
			await primeOnboardStart(instance, domain);

			const started = Date.now();
			const response = await authedCall("/icp/onboard", { domain });
			const elapsedMs = Date.now() - started;
			const body: { runId?: string; status?: string } = await response.json();

			expect(response.status).toBe(202);
			expect(body.runId).toBe(runId);
			expect(body.status).toBe("started");
			expect(elapsedMs).toBeLessThan(2000);
		} finally {
			await instance.dispose();
		}
	});
});

describe("POST /icp/onboard: a same-day repeat", () => {
	it("does not create a second icp or run row for the same organization and domain", async () => {
		const domain = `acme-${crypto.randomUUID()}.example`;
		const scopeId = await onboardScopeId({ domain }, CALLER_ORGANIZATION_ID);
		const runId = buildRunId("onboarding", scopeId);
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			runId,
		);
		try {
			await primeOnboardProfile(instance, domain, { costDollars: 0 });

			const first = await authedCall("/icp/onboard", { domain });
			const firstBody: { runId: string; status?: string } = await first.json();
			await instance.waitForStatus("complete");
			const second = await authedCall("/icp/onboard", { domain });
			const secondBody: { runId: string; status?: string } =
				await second.json();
			const icpRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection.select().from(icpTable).where(eq(icpTable.domain, domain)),
			);

			expect(firstBody.status).toBe("started");
			expect(secondBody.status).toBe("existing");
			expect(secondBody.runId).toBe(firstBody.runId);
			expect(icpRows).toHaveLength(1);
		} finally {
			await instance.dispose();
			await deleteIcpAndRun(runId);
		}
	});
});

type SpentDaySeed = {
	organizationId: string;
	icpId: string;
	spentRunId: string;
};

async function seedSpentDay(): Promise<SpentDaySeed> {
	const org = await organizationForSlug(
		testEnv,
		`onboard-ceiling-${crypto.randomUUID()}.internal`,
		"onboard-ceiling",
	);
	const icpRow = await createIcp(testEnv, {
		description: "seed profile for the onboarding ceiling test",
		domain: org.slug,
		organizationId: org.id,
	});
	const spentRunId = `companies_onboard-ceiling-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: spentRunId,
		organizationId: org.id,
		icpId: icpRow.id,
		capability: "companies",
		status: "running",
	});
	await closeRun(testEnv, spentRunId, {
		status: "complete",
		costDollars: config.spend.perAccountDailyDollars,
	});
	return { organizationId: org.id, icpId: icpRow.id, spentRunId };
}

async function cleanupSpentDay(seed: SpentDaySeed): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(run).where(eq(run.id, seed.spentRunId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
	});
}

describe("OnboardIcpWorkflow: the daily spend ceiling", () => {
	it("refuses a run for an account whose day already costs the ceiling, before any paid call", async () => {
		const seed = await seedSpentDay();
		const instanceId = `onboarding_ceiling-${crypto.randomUUID()}`;
		const domain = `ceiling-${crypto.randomUUID()}.example`;
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			instanceId,
		);
		try {
			await primeOnboardProfile(instance, domain, { costDollars: 0.02 });
			await testEnv.ONBOARD_ICP.create({
				id: instanceId,
				params: { domain, note: null, organizationId: seed.organizationId },
			});
			await instance.waitForStatus("errored");

			expect(await findRun(testEnv, instanceId)).toBeUndefined();
		} finally {
			await instance.dispose();
			await cleanupSpentDay(seed);
		}
	});
});

describe("publicHostname", () => {
	it("refuses a host with no dot and an address literal, and accepts a real domain", () => {
		expect(() => publicHostname("localhost")).toThrow(NonRetryableError);
		expect(() => publicHostname("192.168.0.1")).toThrow(NonRetryableError);
		expect(publicHostname("https://www.form3.tech/about")).toBe("form3.tech");
	});
});

describe("two callers racing to start the same run", () => {
	it("answers both without an error, naming the same run", async () => {
		const domain = `race-${crypto.randomUUID()}.example`;
		const scopeId = await onboardScopeId({ domain }, CALLER_ORGANIZATION_ID);
		const runId = buildRunId("onboarding", scopeId);
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			runId,
		);
		try {
			await primeOnboardStart(instance, domain, { costDollars: 0 });

			const both = await Promise.all([
				authedCall("/icp/onboard", { domain }),
				authedCall("/icp/onboard", { domain }),
			]);
			const bodies = await Promise.all(
				both.map((r) => r.json<{ runId?: string }>()),
			);

			for (const response of both) expect(response.status).toBeLessThan(300);
			expect(bodies.map((b) => b.runId)).toEqual([runId, runId]);
		} finally {
			await instance.dispose();
		}
	});
});
