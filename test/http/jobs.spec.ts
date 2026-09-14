import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { createIcp, openRun } from "@/core/db/queries";
import { draftIcp } from "@/core/icp";
import { buildRunId, domainsScopeId } from "@/http/jobs";
import { peopleFindSchema } from "@/http/schemas";
import app from "@/index";
import { issueOrganizationKey } from "../support/db";

const BASE = "https://algo.test";

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

beforeAll(async () => {
	const issued = await issueOrganizationKey(
		`jobs-caller-${crypto.randomUUID()}`,
	);
	TOKEN = issued.key;
	CALLER_ORGANIZATION_ID = issued.organizationId;
});

async function call(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`${BASE}${path}`, init), testEnv);
}

function postInit(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${TOKEN}`,
		},
		body: JSON.stringify(body),
	};
}

async function terminateRun(runId: string | undefined): Promise<void> {
	if (runId === undefined) return;
	const bindings: Workflow[] = [
		testEnv.FIND_COMPANIES,
		testEnv.FIND_PEOPLE,
		testEnv.ONBOARD_ICP,
	];
	for (const binding of bindings) {
		const instance = await binding.get(runId).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
}

async function seedOwnedIcp(label: string): Promise<string> {
	const profileDomain = `jobs-${label}-${crypto.randomUUID()}.internal`;
	const icpRow = await createIcp(testEnv, {
		doc: draftIcp(profileDomain, `seed icp for ${label}`),
		domain: profileDomain,
		organizationId: CALLER_ORGANIZATION_ID,
	});
	return icpRow.id;
}

async function seedCompaniesRun(
	label: string,
	icpId: string | null = null,
): Promise<string> {
	const runId = `companies_${label}-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: CALLER_ORGANIZATION_ID,
		icpId,
		capability: "companies",
		status: "complete",
	});
	return runId;
}

async function seedForeignIcp(): Promise<string> {
	const foreignOrganizationId = `foreign-org-${crypto.randomUUID()}`;
	await withConnection(testEnv, "cached", db, (connection) =>
		connection.insert(organization).values({
			id: foreignOrganizationId,
			name: "foreign org",
			slug: foreignOrganizationId,
			createdAt: new Date(),
		}),
	);
	const profileDomain = `jobs-foreign-${crypto.randomUUID()}.internal`;
	const foreignIcp = await createIcp(testEnv, {
		doc: draftIcp(profileDomain, "a profile owned by another organization"),
		domain: profileDomain,
		organizationId: foreignOrganizationId,
	});
	return foreignIcp.id;
}

describe("POST /companies/find: a malformed body", () => {
	it("rejects it with the Zod issue list and starts no instance", async () => {
		const icpId = await seedOwnedIcp("malformed-body");
		const response = await call(
			"/companies/find",
			postInit({ icpId, count: "five" }),
		);
		const body: { issues?: unknown[] } = await response.json();
		const today = new Date().toISOString().slice(0, 10);

		expect(response.status).toBe(400);
		expect(body.issues?.length).toBeGreaterThan(0);
		const status = await call(`/runs/companies_${icpId}_${today}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(status.status).toBe(404);
	});
});

describe("POST /companies/find: the run id and same-day idempotency", () => {
	it("returns 202 with a runId built from capability, icpId, and today, as a new run", async () => {
		const icpId = await seedOwnedIcp("new-run");
		const response = await call(
			"/companies/find",
			postInit({ icpId, count: 3 }),
		);
		const body: { runId?: string; status?: string } = await response.json();
		await terminateRun(body.runId);
		const today = new Date().toISOString().slice(0, 10);

		expect(response.status).toBe(202);
		expect(body.runId).toBe(`companies_${icpId}_${today}`);
		expect(body.status).toBe("started");
	});

	it("reports a same-day repeat as existing, even when the repeat's count differs", async () => {
		const icpId = await seedOwnedIcp("repeat");
		const first = await call("/companies/find", postInit({ icpId, count: 4 }));
		const second = await call(
			"/companies/find",
			postInit({ icpId, count: 50 }),
		);
		const firstBody: { runId: string; status?: string } = await first.json();
		const secondBody: { runId: string; status?: string } = await second.json();
		await terminateRun(firstBody.runId);

		expect(first.status).toBe(202);
		expect(firstBody.status).toBe("started");
		expect(second.status).toBe(200);
		expect(secondBody.status).toBe("existing");
		expect(secondBody.runId).toBe(firstBody.runId);
	});

	it("keeps the plain run id with no exclusions, but diverges once exclusions differ", async () => {
		const icpId = await seedOwnedIcp("exclusions");
		const today = new Date().toISOString().slice(0, 10);
		const plain = await call("/companies/find", postInit({ icpId, count: 4 }));
		const withA = await call(
			"/companies/find",
			postInit({ icpId, count: 4, excludeDomains: ["competitor.com"] }),
		);
		const withB = await call(
			"/companies/find",
			postInit({ icpId, count: 4, excludeDomains: ["rival.com"] }),
		);
		const plainBody: { runId: string } = await plain.json();
		const aBody: { runId: string } = await withA.json();
		const bBody: { runId: string } = await withB.json();
		await terminateRun(plainBody.runId);
		await terminateRun(aBody.runId);
		await terminateRun(bBody.runId);

		expect(plainBody.runId).toBe(`companies_${icpId}_${today}`);
		expect(new Set([plainBody.runId, aBody.runId, bBody.runId]).size).toBe(3);
	});
});

async function expectedPeopleRunId(
	rawBody: z.input<typeof peopleFindSchema>,
): Promise<string> {
	const parsed = peopleFindSchema.parse(rawBody);
	const scopeId = await domainsScopeId(
		[JSON.stringify(parsed)],
		CALLER_ORGANIZATION_ID,
	);
	return buildRunId("people", scopeId);
}

describe("POST /people/find: request-scoped run ids", () => {
	it("scopes the run to a digest of the whole request, changing with any field", async () => {
		const companiesRunId = await seedCompaniesRun("scope-hash");
		const base = { runId: companiesRunId, maxCompanies: 5 };
		const expected = await expectedPeopleRunId(base);

		const first = await call("/people/find", postInit(base));
		const firstBody: { runId: string } = await first.json();
		const changedCount = await call(
			"/people/find",
			postInit({ ...base, maxCompanies: 6 }),
		);
		const changedTarget = await call(
			"/people/find",
			postInit({ ...base, target: ["Head of Growth"] }),
		);
		const changedBody: { runId: string } = await changedCount.json();
		const targetBody: { runId: string } = await changedTarget.json();
		await terminateRun(firstBody.runId);
		await terminateRun(changedBody.runId);
		await terminateRun(targetBody.runId);

		expect(firstBody.runId).toBe(expected);
		expect(
			new Set([firstBody.runId, changedBody.runId, targetBody.runId]).size,
		).toBe(3);
	});

	it("scopes a domains request to a digest of the normalised list, deduping case and www", async () => {
		const first = await call(
			"/people/find",
			postInit({ domains: ["Acme.com", "https://www.beta.com"] }),
		);
		const second = await call(
			"/people/find",
			postInit({ domains: ["www.BETA.com", "acme.com"] }),
		);
		const firstBody: { runId: string; status?: string } = await first.json();
		const secondBody: { runId: string; status?: string } = await second.json();
		await terminateRun(firstBody.runId);

		expect(first.status).toBe(202);
		expect(second.status).toBe(200);
		expect(secondBody.status).toBe("existing");
		expect(secondBody.runId).toBe(firstBody.runId);
	});

	it("rejects a body with neither runId nor domains, and one with both", async () => {
		const neither = await call("/people/find", postInit({}));
		const both = await call(
			"/people/find",
			postInit({
				runId: buildRunId("companies", crypto.randomUUID()),
				domains: ["acme.com"],
			}),
		);

		expect(neither.status).toBe(400);
		expect(both.status).toBe(400);
	});

	it("rejects an oversized target list and a foreign icpId before a workflow starts", async () => {
		const companiesRunId = await seedCompaniesRun("oversized-target");
		const oversized = await call(
			"/people/find",
			postInit({
				runId: companiesRunId,
				target: Array.from({ length: 21 }, (_, i) => `Title ${i}`),
			}),
		);
		const foreignIcpId = await seedForeignIcp();
		const foreignRef = await call(
			"/people/find",
			postInit({
				domains: [`foreign-icp-${crypto.randomUUID()}.example`],
				icpId: foreignIcpId,
			}),
		);

		expect(oversized.status).toBe(400);
		expect(foreignRef.status).toBe(404);
	});
});

describe("POST /people/find: both entry shapes", () => {
	it("accepts a runId or a domains list, and lets the target drive who is searched", async () => {
		const runId = await seedCompaniesRun("both-shapes");
		const expected = await expectedPeopleRunId({
			runId,
			target: ["VP Product"],
		});
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			expected,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies: [], icpId: null, unknownDomains: [] },
				);
			});

			const response = await call(
				"/people/find",
				postInit({ runId, target: ["VP Product"] }),
			);
			const started: { runId?: string } = await response.json();
			expect(response.status).toBe(202);
			expect(started.runId).toBe(expected);

			await instance.waitForStatus("complete");
			const status = await call(`/runs/${expected}`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			const body: { summary?: { mode?: string; buyerSource?: string } } =
				await status.json();
			expect(body.summary?.mode).toBe("target");
			expect(body.summary?.buyerSource).toBe("target");
		} finally {
			await instance.dispose();
		}
	});
});
