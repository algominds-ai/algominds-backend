import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth, startOnboarding } from "@/auth";
import { buildRunId, onboardScopeId } from "@/http/jobs";

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
	it("starts one run under the run id the endpoint would build, carrying the domain and organization", async () => {
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
		const scopeId = await onboardScopeId({ domain: "form3.tech" }, "org-1");
		expect(started[0]?.id).toBe(buildRunId("onboarding", scopeId));
	});

	it("starts nothing for an organization naming no domain, or one that is not a public hostname", async () => {
		const { env, started } = recordingEnv();

		await startOnboarding(env, { id: "org-1", domain: null });
		await startOnboarding(env, { id: "org-1" });
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

	it("starts onboarding because the hook is wired into organization creation, not because a test called it directly", async () => {
		const { env, started } = recordingEnv();
		const auth = createAuth(env);
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
			body: { name: label, slug: label, domain, userId: signedUp.user.id },
		});

		expect(started).toHaveLength(1);
		expect(started[0]?.params).toEqual({
			domain,
			note: null,
			organizationId: String(organization?.id),
		});
	});

	it("starts nothing when the organization the hook creates names no domain", async () => {
		const { env, started } = recordingEnv();
		const auth = createAuth(env);
		const label = `unhooked-${crypto.randomUUID()}`;
		const signedUp = await auth.api.signUpEmail({
			body: {
				name: label,
				email: `${label}@example.com`,
				password: "correct-horse-battery-staple",
			},
		});

		await auth.api.createOrganization({
			body: { name: label, slug: label, userId: signedUp.user.id },
		});

		expect(started).toHaveLength(0);
	});
});
