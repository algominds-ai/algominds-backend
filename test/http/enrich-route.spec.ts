import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { openRun } from "@/core/db/queries";
import type { EnrichOutcome, EnrichSubject } from "@/core/enrich";
import app from "@/index";
import { issueOrganizationKey } from "../support/db";

const BASE = "https://algo.test";

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

beforeAll(async () => {
	const issued = await issueOrganizationKey(
		`enrich-route-caller-${crypto.randomUUID()}`,
	);
	TOKEN = issued.key;
	CALLER_ORGANIZATION_ID = issued.organizationId;
});

async function call(path: string, body: unknown): Promise<Response> {
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

async function seedSourceRun(): Promise<string> {
	const runId = `people_enrich-route-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: CALLER_ORGANIZATION_ID,
		icpId: null,
		capability: "people",
		status: "complete",
	});
	return runId;
}

async function primeEnrichRun(
	runId: string,
	subjects: EnrichSubject[],
	outcomes: EnrichOutcome[],
): Promise<Awaited<ReturnType<typeof introspectWorkflowInstance>>> {
	const instance = await introspectWorkflowInstance(testEnv.ENRICH, runId);
	await instance.modify(async (m) => {
		await m.mockStepResult(
			{ name: "load-source-run" },
			{ organizationId: CALLER_ORGANIZATION_ID, icpId: "icp-1" },
		);
		await m.mockStepResult({ name: "open-run" }, { alreadySpent: 0 });
		await m.mockStepResult({ name: "close-run" }, { id: runId });
		await m.mockStepResult({ name: "resolve-subjects" }, subjects);
		await m.mockStepResult(
			{ name: "enrich-batch-0" },
			{ outcomes, costDollars: 0.02 },
		);
	});
	return instance;
}

describe("POST /enrich", () => {
	it("starts a run scoped by the source run, resolving its actual subjects", async () => {
		const sourceRun = await seedSourceRun();
		const today = new Date().toISOString().slice(0, 10);
		const runId = `enrich_${sourceRun}_${today}`;
		const subjects: EnrichSubject[] = [
			{
				id: "person-route-test",
				linkedinUrl: "https://linkedin.com/in/route-test",
			},
		];
		const outcomes: EnrichOutcome[] = [
			{
				subjectId: "person-route-test",
				linkedin: {
					status: "found",
					value: "https://linkedin.com/in/route-test",
					source: "subject",
				},
			},
		];
		const instance = await primeEnrichRun(runId, subjects, outcomes);
		try {
			const response = await call("/enrich", {
				runId: sourceRun,
				channels: ["linkedin"],
			});
			const body: { runId?: string } = await response.json();
			expect(response.status).toBe(202);
			expect(body.runId).toBe(runId);

			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toEqual({
				outcomes,
				costDollars: 0.02,
			});
		} finally {
			await instance.dispose();
		}
	});

	it("rejects a body with an unknown channel", async () => {
		const sourceRun = await seedSourceRun();
		const response = await call("/enrich", {
			runId: sourceRun,
			channels: ["phone"],
		});
		expect(response.status).toBe(400);
	});
});
