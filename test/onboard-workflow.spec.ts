import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { ORGANIZATION_KEY_CONFIG_ID } from "../src/auth-options";
import { config } from "../src/config";
import { db } from "../src/core/db/client";
import { organizationForSlug } from "../src/core/db/organizations";
import {
	closeRun,
	createIcp,
	findRun,
	loadIcp,
	openRun,
} from "../src/core/db/queries";
import { organizationSpendToday } from "../src/core/db/runs";
import { icp as icpTable, run } from "../src/core/db/schema";
import { NOTE_MAX_LENGTH } from "../src/core/onboard";
import type { IcpSeller } from "../src/core/synthesize";
import { buildRunId, domainsScopeId } from "../src/http/jobs";
import app from "../src/index";
import { ONBOARD_STEPS, publicHostname } from "../src/workflows/onboard-icp";

const BASE = "https://onboard.test";

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

/**
 * Mints a real key for a real organization by walking the provisioning path
 * a caller would: sign up a user, create an organization it owns, then mint
 * a key for that organization.
 */
async function issueKey(
	label: string,
): Promise<{ key: string; organizationId: string }> {
	const auth = createAuth(testEnv);
	const signedUp = await auth.api.signUpEmail({
		body: {
			name: label,
			email: `${label}@onboard.test`,
			password: "correct-horse-battery-staple",
		},
	});
	const org = await auth.api.createOrganization({
		body: { name: label, slug: label, userId: signedUp.user.id },
	});
	const created = await auth.api.createApiKey({
		body: {
			configId: ORGANIZATION_KEY_CONFIG_ID,
			organizationId: org.id,
			userId: signedUp.user.id,
			name: "test-key",
		},
	});
	return { key: created.key, organizationId: org.id };
}

beforeAll(async () => {
	const issued = await issueKey(`onboard-caller-${crypto.randomUUID()}`);
	TOKEN = issued.key;
	CALLER_ORGANIZATION_ID = issued.organizationId;
});

async function authedCall(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`${BASE}${path}`, init), testEnv);
}

function postInit(body: unknown, token: string): RequestInit {
	return {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	};
}

function authedGetInit(): RequestInit {
	return { headers: { authorization: `Bearer ${TOKEN}` } };
}

function mockedSeller(domain: string): IcpSeller {
	return { domain, customers: ["Acme Corp"], competitorTest: "test" };
}

async function deleteIcpAndRun(runId: string): Promise<void> {
	const runRow = await findRun(testEnv, runId);
	await db(testEnv, "direct").delete(run).where(eq(run.id, runId));
	if (runRow?.icpId) {
		await db(testEnv, "direct")
			.delete(icpTable)
			.where(eq(icpTable.id, runRow.icpId));
	}
}

describe("POST /icp/onboard: validation", () => {
	it("rejects a body with no domain", async () => {
		const response = await authedCall("/icp/onboard", postInit({}, TOKEN));
		const body: { issues?: unknown[] } = await response.json();

		expect(response.status).toBe(400);
		expect(Array.isArray(body.issues)).toBe(true);
		expect(body.issues?.length).toBeGreaterThan(0);
	});

	it("rejects a body whose domain is not a public hostname", async () => {
		for (const domain of ["not a domain", "localhost", "10.0.0.7"]) {
			const response = await authedCall(
				"/icp/onboard",
				postInit({ domain }, TOKEN),
			);
			const body: { issues?: unknown[] } = await response.json();

			expect(response.status).toBe(400);
			expect(Array.isArray(body.issues)).toBe(true);
		}
	});

	it("refuses a note longer than the cap the core function enforces", async () => {
		const response = await authedCall(
			"/icp/onboard",
			postInit(
				{ domain: "acme.example", note: "x".repeat(NOTE_MAX_LENGTH + 1) },
				TOKEN,
			),
		);

		expect(response.status).toBe(400);
	});
});

describe("POST /icp/onboard: starts a workflow without waiting for the profile", () => {
	it("returns 202 with a runId built from the domain scope, well under the profile's own latency", async () => {
		const domain = `acme-${crypto.randomUUID()}.example`;
		const scopeId = await domainsScopeId([domain], CALLER_ORGANIZATION_ID);
		const runId = buildRunId("onboarding", scopeId);
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			runId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult({ name: ONBOARD_STEPS.checkSpend }, {});
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.openRun },
					{ alreadySpent: 0 },
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.01,
					},
				);
				await m.mockStepResult({ name: ONBOARD_STEPS.bankSearch }, {});
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.writeProfile },
					{
						description: "a mocked ideal customer profile",
						seller: mockedSeller(domain),
						costDollars: 0.01,
					},
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.saveIcp },
					"mocked-icp-id",
				);
			});

			const started = Date.now();
			const response = await authedCall(
				"/icp/onboard",
				postInit({ domain }, TOKEN),
			);
			const elapsedMs = Date.now() - started;
			const body: { runId?: string; status?: string; icpId?: string } =
				await response.json();

			expect(response.status).toBe(202);
			expect(body.runId).toBe(runId);
			expect(body.status).toBe("started");
			expect(body.icpId).toBeUndefined();
			expect(elapsedMs).toBeLessThan(2000);
		} finally {
			await instance.dispose();
		}
	});
});

describe("POST /icp/onboard: a same-day repeat", () => {
	it("does not create a second icp or run row for the same organization and domain", async () => {
		const domain = `acme-${crypto.randomUUID()}.example`;
		const scopeId = await domainsScopeId([domain], CALLER_ORGANIZATION_ID);
		const runId = buildRunId("onboarding", scopeId);
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			runId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.01,
					},
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.writeProfile },
					{
						description: "a mocked ideal customer profile",
						seller: mockedSeller(domain),
						costDollars: 0,
					},
				);
			});

			const first = await authedCall(
				"/icp/onboard",
				postInit({ domain }, TOKEN),
			);
			const firstBody: { runId: string; status?: string } = await first.json();
			await instance.waitForStatus("complete");

			const second = await authedCall(
				"/icp/onboard",
				postInit({ domain }, TOKEN),
			);
			const secondBody: { runId: string; status?: string } =
				await second.json();

			expect(first.status).toBe(202);
			expect(firstBody.status).toBe("started");
			expect(second.status).toBe(200);
			expect(secondBody.status).toBe("existing");
			expect(secondBody.runId).toBe(firstBody.runId);

			const icpRows = await db(testEnv, "direct")
				.select()
				.from(icpTable)
				.where(eq(icpTable.domain, domain));
			expect(icpRows).toHaveLength(1);
		} finally {
			await instance.dispose();
			await deleteIcpAndRun(runId);
		}
	});
});

describe("OnboardIcpWorkflow: persisting the profile", () => {
	it("writes one icp row carrying the description and seller block, and a run row GET /runs/:runId resolves", async () => {
		const domain = `acme-${crypto.randomUUID()}.example`;
		const instanceId = `onboarding_persist-${crypto.randomUUID()}`;
		const seller = mockedSeller(domain);
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.01,
					},
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.writeProfile },
					{
						description: "a four paragraph ideal customer profile",
						seller,
						wroteProfile: true,
						costDollars: 0.02,
					},
				);
			});

			await testEnv.ONBOARD_ICP.create({
				id: instanceId,
				params: {
					domain,
					note: null,
					organizationId: CALLER_ORGANIZATION_ID,
				},
			});
			await instance.waitForStatus("complete");

			const runRow = await findRun(testEnv, instanceId);
			if (!runRow) throw new Error("expected a run row for onboarding");
			expect(runRow.status).toBe("complete");
			expect(runRow.costDollars).toBe(0.03);
			expect(runRow.capability).toBe("onboarding");

			const icpId = runRow.icpId;
			if (icpId === null) throw new Error("expected the run to name a profile");
			const output = await instance.getOutput();
			expect(output).toEqual({
				icpId,
				costDollars: 0.03,
				wroteProfile: true,
			});

			const icpRow = await loadIcp(testEnv, icpId);
			if (!icpRow) throw new Error("expected an icp row for onboarding");
			expect(icpRow.doc).toEqual({
				description: "a four paragraph ideal customer profile",
				seller,
			});

			const statusResponse = await authedCall(
				`/runs/${instanceId}`,
				authedGetInit(),
			);
			const statusBody: { runId?: string; costDollars?: number } =
				await statusResponse.json();
			expect(statusResponse.status).toBe(200);
			expect(statusBody.runId).toBe(instanceId);
			expect(statusBody.costDollars).toBe(0.03);
		} finally {
			await instance.dispose();
			await deleteIcpAndRun(instanceId);
		}
	});
});

describe("OnboardIcpWorkflow: the daily spend ceiling", () => {
	it("refuses a run for an account whose day already costs the ceiling, before any paid call", async () => {
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

		const instanceId = `onboarding_ceiling-${crypto.randomUUID()}`;
		const domain = `ceiling-${crypto.randomUUID()}.example`;
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.01,
					},
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.writeProfile },
					{
						description: "a profile the ceiling should have prevented",
						seller: mockedSeller(domain),
						wroteProfile: true,
						costDollars: 0.02,
					},
				);
			});

			await testEnv.ONBOARD_ICP.create({
				id: instanceId,
				params: { domain, note: null, organizationId: org.id },
			});
			await instance.waitForStatus("errored");

			expect(await findRun(testEnv, instanceId)).toBeUndefined();
		} finally {
			await instance.dispose();
			await db(testEnv, "direct").delete(run).where(eq(run.id, spentRunId));
			await db(testEnv, "direct")
				.delete(icpTable)
				.where(eq(icpTable.id, icpRow.id));
		}
	});
});

describe("the onboarding workflow refuses a domain that is not a public hostname", () => {
	it("refuses a host with no dot and an address literal, and accepts a real domain", () => {
		expect(() => publicHostname("localhost")).toThrow(NonRetryableError);
		expect(() => publicHostname("192.168.0.1")).toThrow(NonRetryableError);
		expect(publicHostname("https://www.form3.tech/about")).toBe("form3.tech");
	});
});

describe("OnboardIcpWorkflow: a run that dies after buying something", () => {
	it("still leaves a run row carrying what it spent, so the ceiling counts it", async () => {
		const org = await organizationForSlug(
			testEnv,
			`onboard-banked-${crypto.randomUUID()}.internal`,
			"onboard-banked",
		);
		const instanceId = `onboarding_banked-${crypto.randomUUID()}`;
		const domain = `banked-${crypto.randomUUID()}.example`;
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.04,
					},
				);
				await m.mockStepError(
					{ name: ONBOARD_STEPS.writeProfile },
					new NonRetryableError("the model was unreachable"),
				);
			});

			await testEnv.ONBOARD_ICP.create({
				id: instanceId,
				params: { domain, note: null, organizationId: org.id },
			});
			await instance.waitForStatus("errored");

			const runRow = await findRun(testEnv, instanceId);
			if (!runRow) throw new Error("expected a run row for the failed run");
			expect(runRow.costDollars).toBe(0.04);
			expect(runRow.icpId).toBeNull();
			expect(await organizationSpendToday(testEnv, org.id)).toBe(0.04);
		} finally {
			await instance.dispose();
			await deleteIcpAndRun(instanceId);
		}
	});
});

describe("POST /icp/onboard: after a run has failed", () => {
	it("lets the caller retry the same day rather than waiting for it to roll over", async () => {
		const domain = `retry-${crypto.randomUUID()}.example`;
		const scopeId = await domainsScopeId([domain], CALLER_ORGANIZATION_ID);
		const runId = buildRunId("onboarding", scopeId);
		const instance = await introspectWorkflowInstance(
			testEnv.ONBOARD_ICP,
			runId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepError(
					{ name: ONBOARD_STEPS.checkSpend },
					new NonRetryableError("the ceiling read failed"),
				);
			});
			await testEnv.ONBOARD_ICP.create({
				id: runId,
				params: {
					domain,
					note: null,
					organizationId: CALLER_ORGANIZATION_ID,
				},
			});
			await instance.waitForStatus("errored");

			const retry = await authedCall(
				"/icp/onboard",
				postInit({ domain }, TOKEN),
			);
			const body: { runId?: string; status?: string } = await retry.json();

			expect(retry.status).toBe(202);
			expect(body.runId).toBe(runId);
			expect(body.status).toBe("started");
		} finally {
			await instance.dispose();
			await deleteIcpAndRun(runId);
		}
	});
});

describe("OnboardIcpWorkflow: a second attempt after a failed one", () => {
	it("adds to what the failed attempt spent rather than replacing it", async () => {
		const org = await organizationForSlug(
			testEnv,
			`onboard-additive-${crypto.randomUUID()}.internal`,
			"onboard-additive",
		);
		const runId = `onboarding_additive-${crypto.randomUUID()}`;
		const domain = `additive-${crypto.randomUUID()}.example`;
		const params = { domain, note: null, organizationId: org.id };

		const first = await introspectWorkflowInstance(testEnv.ONBOARD_ICP, runId);
		try {
			await first.modify(async (m) => {
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.04,
					},
				);
				await m.mockStepError(
					{ name: ONBOARD_STEPS.writeProfile },
					new NonRetryableError("the model was unreachable"),
				);
			});
			await testEnv.ONBOARD_ICP.create({ id: runId, params });
			await first.waitForStatus("errored");
			expect((await findRun(testEnv, runId))?.costDollars).toBe(0.04);
		} finally {
			await first.dispose();
		}

		const second = await introspectWorkflowInstance(testEnv.ONBOARD_ICP, runId);
		try {
			await second.modify(async (m) => {
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.01,
					},
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.writeProfile },
					{
						description: "a profile written on the second attempt",
						seller: mockedSeller(domain),
						wroteProfile: true,
						costDollars: 0.02,
					},
				);
			});
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

describe("OnboardIcpWorkflow: a run that buys a model call and gets no profile", () => {
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
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.readSeller },
					{
						pages: [{ url: `https://${domain}/`, text: "" }],
						costDollars: 0.01,
					},
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.writeProfile },
					{
						description: null,
						seller: mockedSeller(domain),
						wroteProfile: false,
						costDollars: 0.02,
					},
				);
			});

			await testEnv.ONBOARD_ICP.create({
				id: runId,
				params: { domain, note: null, organizationId: org.id },
			});
			await instance.waitForStatus("errored");

			expect((await findRun(testEnv, runId))?.costDollars).toBeCloseTo(0.03, 5);
			expect(await organizationSpendToday(testEnv, org.id)).toBeCloseTo(
				0.03,
				5,
			);
		} finally {
			await instance.dispose();
			await deleteIcpAndRun(runId);
		}
	});
});
