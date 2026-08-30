import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth, startOnboarding } from "../src/auth";
import { buildRunId, domainsScopeId } from "../src/http/jobs";

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

	it("is wired into the auth instance, not only exported beside it", async () => {
		const auth = createAuth(testEnv);
		const label = `hooked-${crypto.randomUUID()}`;
		const signedUp = await auth.api.signUpEmail({
			body: {
				name: label,
				email: `${label}@example.com`,
				password: "correct-horse-battery-staple",
			},
		});

		const organization = await auth.api.createOrganization({
			body: {
				name: label,
				slug: label,
				domain: "form3.tech",
				userId: signedUp.user.id,
			},
		});

		const scopeId = await domainsScopeId(
			["form3.tech"],
			String(organization?.id),
		);
		const handle = await testEnv.ONBOARD_ICP.get(
			buildRunId("onboarding", scopeId),
		);
		expect(handle.id).toBe(buildRunId("onboarding", scopeId));
	});
});
