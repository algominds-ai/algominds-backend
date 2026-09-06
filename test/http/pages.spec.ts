import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { createIcp, openRun, saveCompanies } from "@/core/db/queries";
import { company, icp as icpTable, run } from "@/core/db/schema";
import { draftIcp } from "@/core/icp";
import app from "@/index";
import { issueOrganizationKey } from "../support/db";

const BASE = "https://algo.test";

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

beforeAll(async () => {
	const issued = await issueOrganizationKey(
		`pages-caller-${crypto.randomUUID()}`,
	);
	TOKEN = issued.key;
	CALLER_ORGANIZATION_ID = issued.organizationId;
});

async function call(path: string, token?: string): Promise<Response> {
	const init =
		token === undefined
			? {}
			: { headers: { authorization: `Bearer ${token}` } };
	return app.fetch(new Request(`${BASE}${path}`, init), testEnv);
}

describe("GET /runs/:runId, /companies, /people: auth and unknown ids", () => {
	it("requires a bearer token on every read route, and reports 404, never an empty 200, for an unknown run", async () => {
		const unknownRun = "companies_never-existed-page-test";
		const noToken = await Promise.all([
			call(`/runs/${unknownRun}`),
			call(`/runs/${unknownRun}/companies`),
			call(`/runs/${unknownRun}/people`),
		]);
		const withToken = await Promise.all([
			call(`/runs/${unknownRun}`, TOKEN),
			call(`/runs/${unknownRun}/companies`, TOKEN),
			call(`/runs/${unknownRun}/people`, TOKEN),
		]);

		for (const response of noToken) expect(response.status).toBe(401);
		for (const response of withToken) expect(response.status).toBe(404);
	});

	it("returns 404 for a capability prefix that maps to no workflow", async () => {
		const response = await call("/runs/unknown-capability_x_1999-01-01", TOKEN);
		expect(response.status).toBe(404);
	});
});

type ForeignRunSeed = {
	foreignOrganizationId: string;
	icpId: string;
	runId: string;
	companyId: string;
};

async function seedForeignRun(): Promise<ForeignRunSeed> {
	const foreignOrganizationId = `foreign-org-${crypto.randomUUID()}`;
	await withConnection(testEnv, "cached", db, (connection) =>
		connection.insert(organization).values({
			id: foreignOrganizationId,
			name: "foreign org",
			slug: foreignOrganizationId,
			createdAt: new Date(),
		}),
	);
	const profileDomain = `pages-cross-org-${crypto.randomUUID()}.internal`;
	const icpRow = await createIcp(testEnv, {
		doc: draftIcp(profileDomain, "seed icp for cross-organization read test"),
		domain: profileDomain,
		organizationId: foreignOrganizationId,
	});
	const runId = `companies_cross-org-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: foreignOrganizationId,
		icpId: icpRow.id,
		capability: "companies",
		status: "complete",
	});
	const [companyRow] = await saveCompanies(testEnv, [
		{
			icpId: icpRow.id,
			organizationId: foreignOrganizationId,
			runId,
			domain: `cross-org-${crypto.randomUUID()}.com`,
			name: "Cross Org Co",
		},
	]);
	if (!companyRow) throw new Error("seed produced no company");
	return {
		foreignOrganizationId,
		icpId: icpRow.id,
		runId,
		companyId: companyRow.id,
	};
}

async function cleanupForeignRun(seed: ForeignRunSeed): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(company).where(eq(company.id, seed.companyId));
		await connection.delete(run).where(eq(run.id, seed.runId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		await connection
			.delete(organization)
			.where(eq(organization.id, seed.foreignOrganizationId));
	});
}

describe("GET /runs/:runId: cross-organization reads", () => {
	it("refuses to read another organization's run, companies, and people", async () => {
		const seed = await seedForeignRun();
		try {
			expect((await call(`/runs/${seed.runId}`, TOKEN)).status).toBe(404);
			expect((await call(`/runs/${seed.runId}/companies`, TOKEN)).status).toBe(
				404,
			);
			expect((await call(`/runs/${seed.runId}/people`, TOKEN)).status).toBe(
				404,
			);
		} finally {
			await cleanupForeignRun(seed);
		}
	});
});

async function waitForRunVisible(
	runId: string,
	attempts = 40,
): Promise<Response> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const response = await call(`/runs/${runId}`, TOKEN);
		if (response.status !== 404) return response;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return call(`/runs/${runId}`, TOKEN);
}

describe("GET /runs/:runId: run status shape", () => {
	it("reports the run this engine keeps, and none of the engine's own working state", async () => {
		const profileDomain = `pages-status-${crypto.randomUUID()}.internal`;
		const icpRow = await createIcp(testEnv, {
			doc: draftIcp(profileDomain, "seed icp for run status shape test"),
			domain: profileDomain,
			organizationId: CALLER_ORGANIZATION_ID,
		});
		const started = await app.fetch(
			new Request(`${BASE}/companies/find`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${TOKEN}`,
				},
				body: JSON.stringify({ icpId: icpRow.id, count: 2 }),
			}),
			testEnv,
		);
		const { runId }: { runId: string } = await started.json();
		try {
			const response = await waitForRunVisible(runId);
			const status: { runId: string; capability: string; costDollars: number } =
				await response.json();
			expect(status.runId).toBe(runId);
			expect(status.capability).toBe("companies");
			expect(typeof status.costDollars).toBe("number");
			expect(Object.keys(status)).not.toContain("__LOCAL_DEV_STEP_OUTPUTS");
			expect(Object.keys(status)).not.toContain("rejects");
		} finally {
			const instance = await testEnv.FIND_COMPANIES.get(runId).catch(
				() => null,
			);
			await instance?.terminate().catch(() => undefined);
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection.delete(run).where(eq(run.id, runId));
				await connection.delete(icpTable).where(eq(icpTable.id, icpRow.id));
			});
		}
	});
});
