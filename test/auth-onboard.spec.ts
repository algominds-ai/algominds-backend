import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth, startOnboarding } from "../src/auth";
import { buildRunId, domainsScopeId } from "../src/http/jobs";
import { ONBOARD_STEPS } from "../src/workflows/onboard-icp";

type StartedBatch = Parameters<Env["ONBOARD_ICP"]["createBatch"]>[0][number];

function recordingEnv(onCreate?: () => never): {
	env: Env;
	started: StartedBatch[];
} {
	const started: StartedBatch[] = [];
	const env: Env = {
		...testEnv,
		ONBOARD_ICP: {
			get: testEnv.ONBOARD_ICP.get.bind(testEnv.ONBOARD_ICP),
			create: testEnv.ONBOARD_ICP.create.bind(testEnv.ONBOARD_ICP),
			deleteBatch: testEnv.ONBOARD_ICP.deleteBatch.bind(testEnv.ONBOARD_ICP),
			createBatch: async (batch: StartedBatch[]) => {
				if (onCreate) onCreate();
				started.push(...batch);
				return [];
			},
		},
	};
	return { env, started };
}

describe("an organization that names a domain begins onboarding", () => {
	it("starts one run carrying that domain and the organization id", async () => {
		const { env, started } = recordingEnv();

		await startOnboarding(env, {
			id: "org-1",
			domain: "https://www.form3.tech/",
		});

		expect(started).toHaveLength(1);
		expect(started[0]?.params).toEqual({
			domain: "form3.tech",
			note: null,
			organizationId: "org-1",
		});
	});

	it("gives the run the same id the endpoint would, so the two never double-charge", async () => {
		const { env, started } = recordingEnv();

		await startOnboarding(env, { id: "org-1", domain: "form3.tech" });

		const scopeId = await domainsScopeId(["form3.tech"], "org-1");
		expect(started[0]?.id).toBe(buildRunId("onboarding", scopeId));
	});

	it("starts nothing for an organization that named no domain", async () => {
		const { env, started } = recordingEnv();

		await startOnboarding(env, { id: "org-1", domain: null });
		await startOnboarding(env, { id: "org-1" });

		expect(started).toHaveLength(0);
	});

	it("starts nothing for a domain that is not a public hostname", async () => {
		const { env, started } = recordingEnv();

		await startOnboarding(env, { id: "org-1", domain: "localhost" });
		await startOnboarding(env, { id: "org-1", domain: "10.0.0.7" });
		await startOnboarding(env, { id: "org-1", domain: "  " });

		expect(started).toHaveLength(0);
	});

	it("lets the organization stand when the run cannot be started", async () => {
		const { env } = recordingEnv(() => {
			throw new Error("workflow binding unavailable");
		});

		await expect(
			startOnboarding(env, { id: "org-1", domain: "form3.tech" }),
		).resolves.toBeUndefined();
	});

	it("reaches the real workflow binding, not only a recording stand-in", async () => {
		const auth = createAuth(testEnv);
		const label = `hooked-${crypto.randomUUID()}`;
		const domain = `hooked-${crypto.randomUUID()}.example`;
		const signedUp = await auth.api.signUpEmail({
			body: {
				name: label,
				email: `${label}@example.com`,
				password: "correct-horse-battery-staple",
			},
		});
		const organization = await auth.api.createOrganization({
			body: { name: label, slug: label, userId: signedUp.user.id },
		});
		const organizationId = String(organization?.id);
		const runId = buildRunId(
			"onboarding",
			await domainsScopeId([domain], organizationId),
		);
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
					{ pages: [], costDollars: 0 },
				);
				await m.mockStepResult({ name: ONBOARD_STEPS.bankSearch }, {});
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.writeProfile },
					{
						description: "a mocked ideal customer profile",
						seller: { domain, customers: [], competitorTest: "none" },
						wroteProfile: true,
						costDollars: 0,
					},
				);
				await m.mockStepResult(
					{ name: ONBOARD_STEPS.saveIcp },
					"mocked-icp-id",
				);
			});

			await startOnboarding(testEnv, { id: organizationId, domain });

			const handle = await testEnv.ONBOARD_ICP.get(runId);
			expect(handle.id).toBe(runId);
			await instance.waitForStatus("complete");
		} finally {
			await instance.dispose();
		}
	});
});
