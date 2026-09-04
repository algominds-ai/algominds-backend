import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import authOptionsSource from "@/auth-options?raw";
import { apikey } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import app from "@/index";
import { disableOrganizationKey, issueOrganizationKey } from "../support/db";

const BASE = "https://algo.test";

function postInit(body: unknown, token?: string): RequestInit {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	return { method: "POST", headers, body: JSON.stringify(body) };
}

function getInit(token?: string): RequestInit {
	return token === undefined
		? {}
		: { headers: { authorization: `Bearer ${token}` } };
}

async function call(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`${BASE}${path}`, init), testEnv);
}

const startedRunIds: string[] = [];

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

afterEach(async () => {
	while (startedRunIds.length > 0) await terminateRun(startedRunIds.pop());
});

describe("bearer authentication", () => {
	it("rejects a request with no credential, an unknown one, or the wrong one", async () => {
		const issued = await issueOrganizationKey(
			`auth-refuse-${crypto.randomUUID()}`,
		);
		const noKey = await call(
			"/companies/find",
			postInit({ count: 1, prompt: "seed fintech companies" }),
		);
		const unknown = await call(
			"/companies/find",
			postInit(
				{ count: 1, prompt: "seed fintech companies" },
				"ak_does-not-exist",
			),
		);
		const wrong = await call(
			"/companies/find",
			postInit({ count: 1, prompt: "seed fintech companies" }, "not-the-token"),
		);
		const unknownBody: unknown = await unknown.json();

		expect(noKey.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(unknownBody).toEqual({ error: "unauthorized" });
		expect(wrong.status).toBe(401);
		void issued;
	});

	it("accepts a request with the correct token, and answers /health with none at all", async () => {
		const issued = await issueOrganizationKey(
			`auth-accept-${crypto.randomUUID()}`,
		);

		const authed = await call(
			"/companies/find",
			postInit({ icpId: crypto.randomUUID(), count: 1 }, issued.key),
		);
		const health = await call("/health");
		const healthBody: { ok: boolean } = await health.json();

		expect(authed.status).not.toBe(401);
		expect(health.status).toBe(200);
		expect(healthBody.ok).toBe(true);
	});
});

describe("cross-tenant access", () => {
	it("refuses org B reading a run or starting one against org A's icpId", async () => {
		const orgA = await issueOrganizationKey(
			`auth-cross-a-${crypto.randomUUID()}`,
		);
		const orgB = await issueOrganizationKey(
			`auth-cross-b-${crypto.randomUUID()}`,
		);
		const started = await call(
			"/companies/find",
			postInit({ prompt: "seed fintech companies", count: 1 }, orgA.key),
		);
		const { runId, icpId }: { runId: string; icpId: string } =
			await started.json();
		startedRunIds.push(runId);

		const readAsB = await call(`/runs/${runId}`, getInit(orgB.key));
		const writeAsB = await call(
			"/companies/find",
			postInit({ icpId, count: 1 }, orgB.key),
		);

		expect(started.status).toBe(202);
		expect(readAsB.status).toBe(404);
		expect(writeAsB.status).toBe(404);
	});
});

describe("a disabled key", () => {
	it("is refused once revoked", async () => {
		const issued = await issueOrganizationKey(
			`auth-disabled-${crypto.randomUUID()}`,
		);
		const before = await call(
			"/companies/find",
			postInit({ prompt: "seed fintech companies", count: 1 }, issued.key),
		);
		const beforeBody: { runId: string } = await before.json();
		startedRunIds.push(beforeBody.runId);

		await disableOrganizationKey(issued);
		const after = await call(
			"/companies/find",
			postInit({ prompt: "seed fintech companies", count: 1 }, issued.key),
		);

		expect(before.status).toBe(202);
		expect(after.status).toBe(401);
	});
});

describe("key storage", () => {
	it("never stores the plaintext key handed to the caller", async () => {
		const issued = await issueOrganizationKey(
			`auth-plaintext-${crypto.randomUUID()}`,
		);

		const rows = await withConnection(testEnv, "direct", db, (connection) =>
			connection
				.select({ key: apikey.key })
				.from(apikey)
				.where(eq(apikey.id, issued.id))
				.limit(1),
		);

		expect(rows[0]?.key).toEqual(expect.any(String));
		expect(rows[0]?.key).not.toBe(issued.key);
	});
});

describe("request volume", () => {
	it("keeps authenticating a key past ten requests in a day", async () => {
		const issued = await issueOrganizationKey(
			`auth-no-quota-${crypto.randomUUID()}`,
		);
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 15; attempt++) {
			const response = await call(
				"/runs/companies_does-not-exist_1999-01-01",
				getInit(issued.key),
			);
			statuses.push(response.status);
		}

		expect(statuses).toHaveLength(15);
		expect(statuses.every((status) => status === 404)).toBe(true);
	});
});

describe("auth options", () => {
	it("never disables key hashing", () => {
		expect(authOptionsSource).not.toContain("disableKeyHashing");
	});
});
