import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { ORGANIZATION_KEY_CONFIG_ID } from "../src/auth-options";
import authOptionsSource from "../src/auth-options?raw";
import { apikey } from "../src/core/db/auth-schema";
import { db } from "../src/core/db/client";
import app from "../src/index";

const BASE = "https://algo.test";

type IssuedKey = {
	key: string;
	id: string;
	organizationId: string;
	userId: string;
};

/**
 * Mints a real key for a real organization by walking the provisioning path
 * a caller would: sign up a user, create an organization it owns, then mint
 * a key for that organization.
 */
async function issueKey(label: string): Promise<IssuedKey> {
	const auth = createAuth(testEnv);
	const signedUp = await auth.api.signUpEmail({
		body: {
			name: label,
			email: `${label}@auth.test`,
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
	return {
		key: created.key,
		id: created.id,
		organizationId: org.id,
		userId: signedUp.user.id,
	};
}

async function disableKey(issued: IssuedKey): Promise<void> {
	await createAuth(testEnv).api.updateApiKey({
		body: {
			configId: ORGANIZATION_KEY_CONFIG_ID,
			keyId: issued.id,
			userId: issued.userId,
			enabled: false,
		},
	});
}

function authedInit(key: string | undefined, body?: unknown): RequestInit {
	const headers: Record<string, string> = {};
	if (key !== undefined) headers["x-api-key"] = key;
	if (body === undefined) return { headers };
	return {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

async function call(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`${BASE}${path}`, init), testEnv);
}

async function terminateRun(runId: string | undefined): Promise<void> {
	if (runId === undefined) return;
	const bindings: Workflow[] = [
		testEnv.FIND_COMPANIES,
		testEnv.FIND_PEOPLE,
		testEnv.ENRICH,
	];
	for (const binding of bindings) {
		const instance = await binding.get(runId).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
}

const startedRunIds: string[] = [];

afterEach(async () => {
	while (startedRunIds.length > 0) {
		await terminateRun(startedRunIds.pop());
	}
});

describe("no credential", () => {
	it("rejects a request with no key at all", async () => {
		const response = await call(
			"/companies/find",
			authedInit(undefined, { prompt: "seed fintech companies", count: 1 }),
		);
		expect(response.status).toBe(401);
	});
});

describe("an unknown key", () => {
	it("is rejected and the body reveals nothing about any organization", async () => {
		const response = await call(
			"/companies/find",
			authedInit("ak_does-not-exist", {
				prompt: "seed fintech companies",
				count: 1,
			}),
		);
		const body: unknown = await response.json();

		expect(response.status).toBe(401);
		expect(body).toEqual({ error: "unauthorized" });
	});
});

describe("cross-tenant access", () => {
	it("refuses org B reading a run that belongs to org A", async () => {
		const orgA = await issueKey(`auth-cross-read-a-${crypto.randomUUID()}`);
		const orgB = await issueKey(`auth-cross-read-b-${crypto.randomUUID()}`);
		const started = await call(
			"/companies/find",
			authedInit(orgA.key, { prompt: "seed fintech companies", count: 1 }),
		);
		const { runId }: { runId: string } = await started.json();
		startedRunIds.push(runId);

		const response = await call(`/runs/${runId}`, authedInit(orgB.key));

		expect(started.status).toBe(202);
		expect(response.status).toBe(404);
	});

	it("refuses org B starting a run against org A's icpId", async () => {
		const orgA = await issueKey(`auth-cross-write-a-${crypto.randomUUID()}`);
		const orgB = await issueKey(`auth-cross-write-b-${crypto.randomUUID()}`);
		const seeded = await call(
			"/companies/find",
			authedInit(orgA.key, { prompt: "seed fintech companies", count: 1 }),
		);
		const seededBody: { runId: string; icpId: string } = await seeded.json();
		startedRunIds.push(seededBody.runId);

		const response = await call(
			"/companies/find",
			authedInit(orgB.key, { icpId: seededBody.icpId, count: 1 }),
		);

		expect(seeded.status).toBe(202);
		expect(response.status).toBe(404);
	});
});

describe("a disabled key", () => {
	it("is refused once revoked", async () => {
		const issued = await issueKey(`auth-disabled-${crypto.randomUUID()}`);
		const beforeDisable = await call(
			"/companies/find",
			authedInit(issued.key, { prompt: "seed fintech companies", count: 1 }),
		);
		const beforeBody: { runId: string } = await beforeDisable.json();
		startedRunIds.push(beforeBody.runId);

		await disableKey(issued);
		const afterDisable = await call(
			"/companies/find",
			authedInit(issued.key, { prompt: "seed fintech companies", count: 1 }),
		);

		expect(beforeDisable.status).toBe(202);
		expect(afterDisable.status).toBe(401);
	});
});

describe("key storage", () => {
	it("never stores the plaintext key handed to the caller", async () => {
		const issued = await issueKey(`auth-plaintext-${crypto.randomUUID()}`);

		const rows = await db(testEnv, "direct")
			.select({ key: apikey.key })
			.from(apikey)
			.where(eq(apikey.id, issued.id))
			.limit(1);
		const stored = rows[0];

		expect(stored).toBeDefined();
		expect(stored?.key).not.toBe(issued.key);
	});
});

describe("request volume", () => {
	it("keeps authenticating a key past ten requests in a day", async () => {
		const issued = await issueKey(`auth-no-quota-${crypto.randomUUID()}`);
		const attempts = 15;
		const statuses: number[] = [];
		for (let attempt = 0; attempt < attempts; attempt++) {
			const response = await call(
				"/runs/companies_does-not-exist_1999-01-01",
				authedInit(issued.key),
			);
			statuses.push(response.status);
		}

		expect(statuses).toHaveLength(attempts);
		expect(statuses.every((status) => status === 404)).toBe(true);
	});
});

describe("auth options", () => {
	it("never disables key hashing", () => {
		expect(authOptionsSource).not.toContain("disableKeyHashing");
	});
});
