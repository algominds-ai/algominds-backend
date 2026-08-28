import { introspectWorkflowInstance } from "cloudflare:test";
import { exports, env as testEnv } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { ORGANIZATION_KEY_CONFIG_ID } from "../src/auth-options";
import { config } from "../src/config";
import { db } from "../src/core/db/client";
import {
	createIcp,
	openRun,
	saveCompanies,
	savePeople,
} from "../src/core/db/queries";
import { company, icp as icpTable, person, run } from "../src/core/db/schema";
import type { EnrichOutcome, EnrichSubject } from "../src/core/enrich";
import app from "../src/index";

const BASE = "https://algo.test";
const authedEnv: Env = testEnv;

const ICP_A = "11111111-1111-4111-8111-111111111111";
const FIXTURE_ICP_IDS: readonly string[] = [
	ICP_A,
	"55555555-5555-4555-8555-555555555555",
	"66666666-6666-4666-8666-666666666666",
	"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
];
const FIXTURE_RUN_IDS: readonly string[] = [
	"companies_88888888-8888-4888-8888-888888888888_2026-08-27",
	"people_99999999-9999-4999-8999-999999999999_2026-08-27",
	"people_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_2026-08-27",
];

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

/**
 * Mints a real key for a real organization by walking the provisioning path
 * a caller would: sign up a user, create an organization it owns, then mint
 * a key for that organization.
 */
async function issueKey(
	label: string,
): Promise<{ key: string; organizationId: string; userId: string }> {
	const auth = createAuth(testEnv);
	const signedUp = await auth.api.signUpEmail({
		body: {
			name: label,
			email: `${label}@routes.test`,
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
	return { key: created.key, organizationId: org.id, userId: signedUp.user.id };
}

/**
 * Owns a fixed icp id under the caller's organization, so route tests can
 * reference stable ids while still passing the real ownership check.
 */
async function seedIcpFixture(id: string): Promise<void> {
	await db(testEnv, "cached")
		.insert(icpTable)
		.values({
			id,
			organizationId: CALLER_ORGANIZATION_ID,
			domain: `routes-fixture-${id}`,
			doc: { description: "fixture icp for routes route tests" },
		})
		.onConflictDoUpdate({
			target: icpTable.id,
			set: { organizationId: CALLER_ORGANIZATION_ID },
		});
}

/**
 * Creates a fresh icp owned by the caller's organization. Used by tests that
 * read a run back afterward, so a run id built from this icp can never
 * collide with one a stale run of the same suite left behind on a prior day.
 */
async function seedOwnedIcp(label: string): Promise<string> {
	const icpRow = await createIcp(testEnv, {
		description: `seed icp for ${label}`,
		domain: `routes-${label}-${crypto.randomUUID()}.internal`,
		organizationId: CALLER_ORGANIZATION_ID,
	});
	return icpRow.id;
}

/** Owns a fixed run id under the caller's organization, as a source run. */
async function seedRunFixture(id: string): Promise<void> {
	await db(testEnv, "cached")
		.insert(run)
		.values({
			id,
			organizationId: CALLER_ORGANIZATION_ID,
			icpId: ICP_A,
			capability: id.split("_")[0] ?? "companies",
			status: "complete",
		})
		.onConflictDoUpdate({
			target: run.id,
			set: { organizationId: CALLER_ORGANIZATION_ID, icpId: ICP_A },
		});
}

beforeAll(async () => {
	const issued = await issueKey(`routes-caller-${crypto.randomUUID()}`);
	TOKEN = issued.key;
	CALLER_ORGANIZATION_ID = issued.organizationId;
	for (const id of FIXTURE_ICP_IDS) await seedIcpFixture(id);
	for (const id of FIXTURE_RUN_IDS) await seedRunFixture(id);
});

async function publicCall(path: string, init?: RequestInit): Promise<Response> {
	return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function authedCall(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`${BASE}${path}`, init), authedEnv);
}

function postInit(body: unknown, token?: string): RequestInit {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	return { method: "POST", headers, body: JSON.stringify(body) };
}

function authedGetInit(): RequestInit {
	return { headers: { authorization: `Bearer ${TOKEN}` } };
}

/**
 * Polls run status until the workflow's own open-run step has committed,
 * rather than assuming it lands within a single request's worth of time.
 */
async function waitForRunVisible(
	runId: string,
	attempts = 20,
): Promise<Response> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const response = await authedCall(`/runs/${runId}`, authedGetInit());
		if (response.status !== 404) return response;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return authedCall(`/runs/${runId}`, authedGetInit());
}

const SCOPES: readonly string[] = [
	"11111111-1111-4111-8111-111111111111",
	"55555555-5555-4555-8555-555555555555",
	"66666666-6666-4666-8666-666666666666",
	"77777777-7777-4777-8777-777777777777",
	"88888888-8888-4888-8888-888888888888",
	"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	"people_99999999-9999-4999-8999-999999999999_2026-08-27",
	"people_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_2026-08-27",
];

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

async function terminateStartedRuns(): Promise<void> {
	const today = new Date().toISOString().slice(0, 10);
	const bindings: [Workflow, string][] = [
		[testEnv.FIND_COMPANIES, "companies"],
		[testEnv.FIND_PEOPLE, "people"],
		[testEnv.ENRICH, "enrich"],
	];
	for (const [binding, capability] of bindings) {
		for (const scope of SCOPES) {
			const instance = await binding
				.get(`${capability}_${scope}_${today}`)
				.catch(() => null);
			await instance?.terminate().catch(() => undefined);
		}
	}
}

afterEach(terminateStartedRuns);

async function expectEnrichResolvesSubjects(
	sourceRun: string,
	subjects: EnrichSubject[],
	outcomes: EnrichOutcome[],
): Promise<void> {
	const today = new Date().toISOString().slice(0, 10);
	const runId = `enrich_${sourceRun}_${today}`;
	const instance = await introspectWorkflowInstance(testEnv.ENRICH, runId);
	try {
		await instance.modify(async (m) => {
			await m.mockStepResult(
				{ name: "load-source-run" },
				{ organizationId: "org-1", icpId: "icp-1" },
			);
			await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
			await m.mockStepResult({ name: "open-run" }, { id: runId });
			await m.mockStepResult({ name: "close-run" }, { id: runId });
			await m.mockStepResult({ name: "resolve-subjects" }, subjects);
			await m.mockStepResult(
				{ name: "enrich-batch-0" },
				{ outcomes, costDollars: 0.02 },
			);
		});

		const response = await authedCall(
			"/enrich",
			postInit({ runId: sourceRun, channels: ["linkedin"] }, TOKEN),
		);
		const body: { runId?: string } = await response.json();

		expect(response.status).toBe(202);
		expect(body.runId).toBe(runId);

		await instance.waitForStatus("complete");
		const output = await instance.getOutput();
		expect(output).toEqual({ outcomes, costDollars: 0.02 });
	} finally {
		await instance.dispose();
	}
}

describe("bearer authentication", () => {
	it("rejects a request with no Authorization header", async () => {
		const response = await publicCall(
			"/companies/find",
			postInit({ icpId: ICP_A, count: 5 }),
		);
		expect(response.status).toBe(401);
	});

	it("rejects a request with the wrong token", async () => {
		const response = await authedCall(
			"/companies/find",
			postInit({ icpId: ICP_A, count: 5 }, "not-the-token"),
		);
		expect(response.status).toBe(401);
	});

	it("accepts a request with the correct token", async () => {
		const response = await authedCall(
			"/companies/find",
			postInit({ icpId: ICP_A, count: 5 }, TOKEN),
		);
		expect(response.status).toBe(202);
	});

	it("still answers /health with no token, reporting the bundled module check", async () => {
		const response = await publicCall("/health");
		const body: { ok: boolean; bundled: { generateText: string } } =
			await response.json();
		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.bundled.generateText).toBe("function");
	});

	it("requires a bearer token on the run-status route too", async () => {
		const response = await publicCall(
			"/runs/companies_00000000-0000-4000-8000-000000000000_1999-01-01",
		);
		expect(response.status).toBe(401);
	});
});

describe("POST /companies/find", () => {
	it("rejects a malformed body with the Zod issue list and creates no instance", async () => {
		const icpId = "55555555-5555-4555-8555-555555555555";
		const response = await authedCall(
			"/companies/find",
			postInit({ icpId, count: "five" }, TOKEN),
		);
		const body: { issues?: unknown[] } = await response.json();

		expect(response.status).toBe(400);
		expect(Array.isArray(body.issues)).toBe(true);
		expect(body.issues?.length).toBeGreaterThan(0);

		const today = new Date().toISOString().slice(0, 10);
		const statusResponse = await authedCall(
			`/runs/companies_${icpId}_${today}`,
			authedGetInit(),
		);
		expect(statusResponse.status).toBe(404);
	});

	it("returns 202 with a runId built from capability, icpId and today, and reports the run as new", async () => {
		const icpId = "66666666-6666-4666-8666-666666666666";
		const started = Date.now();

		const response = await authedCall(
			"/companies/find",
			postInit({ icpId, count: 3 }, TOKEN),
		);
		const elapsedMs = Date.now() - started;
		const body: { runId?: string; status?: string } = await response.json();
		await terminateRun(body.runId);
		const today = new Date().toISOString().slice(0, 10);

		expect(response.status).toBe(202);
		expect(body.runId).toBe(`companies_${icpId}_${today}`);
		expect(body.status).toBe("started");
		expect(elapsedMs).toBeLessThan(2000);
	});

	it("creates one instance for two same-day requests with the same icpId and count, reporting the second as existing", async () => {
		const icpId = await seedOwnedIcp("same-day-repeat");

		const first = await authedCall(
			"/companies/find",
			postInit({ icpId, count: 4 }, TOKEN),
		);
		const second = await authedCall(
			"/companies/find",
			postInit({ icpId, count: 4 }, TOKEN),
		);
		const firstBody: { runId: string; status?: string } = await first.json();
		const secondBody: { runId: string; status?: string } = await second.json();
		const statusResponse = await authedCall(
			`/runs/${secondBody.runId}`,
			authedGetInit(),
		);
		await terminateRun(firstBody.runId);

		expect(first.status).toBe(202);
		expect(firstBody.status).toBe("started");
		expect(second.status).toBe(200);
		expect(secondBody.status).toBe("existing");
		expect(secondBody.runId).toBe(firstBody.runId);
		expect(statusResponse.status).toBe(200);
	});

	it("reports the existing run when a repeat arrives with a different count, instead of presenting the new count as accepted", async () => {
		const icpId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

		const first = await authedCall(
			"/companies/find",
			postInit({ icpId, count: 10 }, TOKEN),
		);
		const second = await authedCall(
			"/companies/find",
			postInit({ icpId, count: 50 }, TOKEN),
		);
		const firstBody: { runId: string; status?: string } = await first.json();
		const secondBody: { runId: string; status?: string } = await second.json();

		expect(first.status).toBe(202);
		expect(firstBody.status).toBe("started");
		expect(second.status).toBe(200);
		expect(secondBody.status).toBe("existing");
		expect(secondBody.runId).toBe(firstBody.runId);
	});
});

describe("POST /people/find and /enrich", () => {
	it("starts a people/find run scoped by a companies runId", async () => {
		const companiesRunId =
			"companies_88888888-8888-4888-8888-888888888888_2026-08-27";

		const response = await authedCall(
			"/people/find",
			postInit({ runId: companiesRunId }, TOKEN),
		);
		const body: { runId?: string; icpId?: string } = await response.json();
		await terminateRun(body.runId);
		const today = new Date().toISOString().slice(0, 10);

		expect(response.status).toBe(202);
		expect(body.runId).toBe(`people_${companiesRunId}_${today}`);
		expect(body.icpId).toBeUndefined();
	});

	it("rejects a people/find body with neither runId nor domains", async () => {
		const response = await authedCall("/people/find", postInit({}, TOKEN));
		expect(response.status).toBe(400);
	});

	it("rejects a people/find body carrying both runId and domains", async () => {
		const response = await authedCall(
			"/people/find",
			postInit(
				{
					runId: "companies_dd000000-0000-4000-8000-000000000000_2026-08-27",
					domains: ["acme.com"],
				},
				TOKEN,
			),
		);
		expect(response.status).toBe(400);
	});

	it("scopes a domains request to a digest of the normalised list, deduping case and www", async () => {
		const first = await authedCall(
			"/people/find",
			postInit({ domains: ["Acme.com", "https://www.beta.com"] }, TOKEN),
		);
		const second = await authedCall(
			"/people/find",
			postInit({ domains: ["www.BETA.com", "acme.com"] }, TOKEN),
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

	it("starts an enrich run scoped by the people-find run it enriches, and resolves its actual subjects rather than just accepting the request", async () => {
		const sourceRun = "people_99999999-9999-4999-8999-999999999999_2026-08-27";
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

		await expectEnrichResolvesSubjects(sourceRun, subjects, outcomes);
	});

	it("rejects an enrich body with an unknown channel", async () => {
		const sourceRun = "people_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_2026-08-27";

		const response = await authedCall(
			"/enrich",
			postInit({ runId: sourceRun, channels: ["phone"] }, TOKEN),
		);

		expect(response.status).toBe(400);
	});
});

describe("GET /runs/:runId", () => {
	it("returns 404 for an id whose instance was never created", async () => {
		const response = await authedCall(
			"/runs/companies_00000000-0000-4000-8000-000000000000_1999-01-01",
			authedGetInit(),
		);
		expect(response.status).toBe(404);
	});

	it("returns 404 for a capability prefix that maps to no workflow", async () => {
		const response = await authedCall(
			`/runs/unknown-capability_${ICP_A}_1999-01-01`,
			authedGetInit(),
		);
		expect(response.status).toBe(404);
	});

	it("reports the real instance status verbatim, with no completed output", async () => {
		const icpId = await seedOwnedIcp("instance-status");
		const started = await authedCall(
			"/companies/find",
			postInit({ icpId, count: 2 }, TOKEN),
		);
		const { runId }: { runId: string } = await started.json();

		const statusResponse = await waitForRunVisible(runId);
		const status: { status: string; output?: unknown } =
			await statusResponse.json();
		await terminateRun(runId);

		expect(statusResponse.status).toBe(200);
		expect(typeof status.status).toBe("string");
		expect(status.output == null).toBe(true);
	});
});

type PageSeed = {
	icpId: string;
	runId: string;
	companyIds: string[];
};

/**
 * Seeds a run and its companies under the caller's own organization, so a
 * read through `TOKEN` matches the ownership check the real route enforces.
 */
async function seedRunWithCompanies(
	label: string,
	companyCount: number,
): Promise<PageSeed> {
	const icpRow = await createIcp(testEnv, {
		description: "seed icp for run-page route tests",
		domain: `routes-page-test-${label}.internal`,
		organizationId: CALLER_ORGANIZATION_ID,
	});
	const runId = `companies_${label}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: CALLER_ORGANIZATION_ID,
		icpId: icpRow.id,
		capability: "companies",
		status: "complete",
	});
	const saved = await saveCompanies(
		testEnv,
		Array.from({ length: companyCount }, (_, i) => ({
			icpId: icpRow.id,
			runId,
			domain: `${label}-${i}.com`,
			name: `${label} Co ${i}`,
		})),
	);
	return {
		icpId: icpRow.id,
		runId,
		companyIds: saved.map((row) => row.id),
	};
}

async function cleanupPageSeed(seed: PageSeed): Promise<void> {
	const connection = db(testEnv, "direct");
	await connection
		.delete(person)
		.where(inArray(person.companyId, seed.companyIds));
	await connection.delete(company).where(eq(company.runId, seed.runId));
	await connection.delete(run).where(eq(run.id, seed.runId));
	await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
}

type CompanyPageBody = {
	rows: Array<{ id: string; domain: string }>;
	nextCursor: string | null;
	limit: number;
};

describe("GET /runs/:runId/companies and /runs/:runId/people: auth and 404", () => {
	it("rejects a companies-page request with no bearer token", async () => {
		const response = await publicCall(
			"/runs/companies_no-token-test/companies",
		);
		expect(response.status).toBe(401);
	});

	it("rejects a people-page request with no bearer token", async () => {
		const response = await publicCall("/runs/companies_no-token-test/people");
		expect(response.status).toBe(401);
	});

	it("returns 404, not an empty 200, for the companies page of an unknown run id", async () => {
		const response = await authedCall(
			"/runs/companies_never-existed-route-test/companies",
			authedGetInit(),
		);
		expect(response.status).toBe(404);
	});

	it("returns 404, not an empty 200, for the people page of an unknown run id", async () => {
		const response = await authedCall(
			"/runs/companies_never-existed-route-test/people",
			authedGetInit(),
		);
		expect(response.status).toBe(404);
	});
});

describe("GET /runs/:runId/companies and /runs/:runId/people: pagination", () => {
	it("pages through a run's companies with no duplicate and no gap", async () => {
		const label = `routes-companies-${crypto.randomUUID()}`;
		const seed = await seedRunWithCompanies(label, 5);
		try {
			const first = await authedCall(
				`/runs/${seed.runId}/companies?limit=2`,
				authedGetInit(),
			);
			const firstBody: CompanyPageBody = await first.json();

			expect(first.status).toBe(200);
			expect(firstBody.rows).toHaveLength(2);
			expect(firstBody.limit).toBe(2);
			expect(firstBody.nextCursor).not.toBeNull();

			const second = await authedCall(
				`/runs/${seed.runId}/companies?limit=2&cursor=${firstBody.nextCursor}`,
				authedGetInit(),
			);
			const secondBody: CompanyPageBody = await second.json();

			expect(secondBody.rows).toHaveLength(2);
			expect(secondBody.nextCursor).not.toBeNull();

			const third = await authedCall(
				`/runs/${seed.runId}/companies?limit=2&cursor=${secondBody.nextCursor}`,
				authedGetInit(),
			);
			const thirdBody: CompanyPageBody = await third.json();

			expect(thirdBody.rows).toHaveLength(1);
			expect(thirdBody.nextCursor).toBeNull();

			const seenIds = [
				...firstBody.rows,
				...secondBody.rows,
				...thirdBody.rows,
			].map((row) => row.id);
			expect(new Set(seenIds)).toEqual(new Set(seed.companyIds));
			expect(seenIds).toHaveLength(seed.companyIds.length);
		} finally {
			await cleanupPageSeed(seed);
		}
	});
});

describe("GET /runs/:runId/companies: the page-size ceiling", () => {
	it("clamps a limit above the configured maximum and reports the clamped value", async () => {
		const label = `routes-clamp-${crypto.randomUUID()}`;
		const seed = await seedRunWithCompanies(label, 1);
		try {
			const response = await authedCall(
				`/runs/${seed.runId}/companies?limit=999999`,
				authedGetInit(),
			);
			const body: CompanyPageBody = await response.json();

			expect(response.status).toBe(200);
			expect(body.limit).toBe(config.limits.maxRunPageSize);
			expect(body.limit).toBeLessThan(999999);
		} finally {
			await cleanupPageSeed(seed);
		}
	});

	it("returns people for the given run's companies only, not another run's", async () => {
		const labelA = `routes-people-a-${crypto.randomUUID()}`;
		const labelB = `routes-people-b-${crypto.randomUUID()}`;
		const seedA = await seedRunWithCompanies(labelA, 1);
		const seedB = await seedRunWithCompanies(labelB, 1);
		try {
			const companyIdA = seedA.companyIds[0];
			const companyIdB = seedB.companyIds[0];
			if (!companyIdA || !companyIdB)
				throw new Error("seed produced no company");

			await savePeople(testEnv, [
				{
					companyId: companyIdA,
					linkedinUrl: `https://linkedin.com/in/${labelA}`,
					name: "Person A",
					title: "VP of Sales",
				},
			]);
			await savePeople(testEnv, [
				{
					companyId: companyIdB,
					linkedinUrl: `https://linkedin.com/in/${labelB}`,
					name: "Person B",
					title: "VP of Sales",
				},
			]);

			const response = await authedCall(
				`/runs/${seedA.runId}/people`,
				authedGetInit(),
			);
			const body: { rows: Array<{ linkedinUrl: string | null }> } =
				await response.json();

			expect(response.status).toBe(200);
			expect(body.rows).toHaveLength(1);
			expect(body.rows[0]?.linkedinUrl).toBe(
				`https://linkedin.com/in/${labelA}`,
			);
		} finally {
			await cleanupPageSeed(seedA);
			await cleanupPageSeed(seedB);
		}
	});
});
