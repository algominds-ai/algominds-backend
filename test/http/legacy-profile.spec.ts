import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, withConnection } from "@/core/db/client";
import { createIcp, openRun, saveCompanies } from "@/core/db/queries";
import { icp } from "@/core/db/schema";
import { draftIcp } from "@/core/icp";
import app from "@/index";
import { issueOrganizationKey } from "../support/db";

const BASE = "https://algo.test";

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

beforeAll(async () => {
	const issued = await issueOrganizationKey(
		`legacy-caller-${crypto.randomUUID()}`,
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

/** An owned profile whose stored document predates the current schema — the shape the start endpoints refuse. */
async function seedLegacyIcp(label: string): Promise<string> {
	const domain = `legacy-${label}-${crypto.randomUUID()}.internal`;
	const icpRow = await createIcp(testEnv, {
		doc: draftIcp(domain, "seed"),
		domain,
		organizationId: CALLER_ORGANIZATION_ID,
	});
	await withConnection(testEnv, "direct", db, (connection) =>
		connection
			.update(icp)
			.set({ doc: { legacy: "shape" } })
			.where(eq(icp.id, icpRow.id)),
	);
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

describe("a stored profile the workflows would reject as legacy", () => {
	it("refuses it at /companies/find before a run is started", async () => {
		const icpId = await seedLegacyIcp("companies");
		const response = await call(
			"/companies/find",
			postInit({ icpId, count: 3 }),
		);
		const body: { error?: string } = await response.json();
		const today = new Date().toISOString().slice(0, 10);
		const runStatus = await call(`/runs/companies_${icpId}_${today}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});

		expect(response.status).toBe(409);
		expect(body.error).toContain("legacy profile");
		expect(runStatus.status).toBe(404);
	});

	it("refuses it at /people/find whether named directly or read off a source run", async () => {
		const icpId = await seedLegacyIcp("people");
		const named = await call(
			"/people/find",
			postInit({
				domains: [`legacy-named-${crypto.randomUUID()}.example`],
				icpId,
			}),
		);
		const sourceRunId = await seedCompaniesRun("legacy-source", icpId);
		const sourced = await call(
			"/people/find",
			postInit({ runId: sourceRunId }),
		);

		expect(named.status).toBe(409);
		expect(sourced.status).toBe(409);
	});

	it("refuses it at /people/find when every named domain shares it as their stored profile", async () => {
		const icpId = await seedLegacyIcp("people-domains");
		const domain = `legacy-shared-${crypto.randomUUID()}.example`;
		const runId = await seedCompaniesRun("legacy-domains");
		await saveCompanies(testEnv, [
			{
				icpId,
				organizationId: CALLER_ORGANIZATION_ID,
				runId,
				domain,
				name: "legacy co",
			},
		]);

		const response = await call(
			"/people/find",
			postInit({ domains: [domain] }),
		);

		expect(response.status).toBe(409);
	});
});
