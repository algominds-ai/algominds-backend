import { exports, env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { constantTimeEqual } from "../src/routes";

const BASE = "https://algo.test";
const TOKEN = "routes-spec-bearer-token";
const authedEnv: Env = {
	...testEnv,
	API_BEARER_TOKEN: { get: async () => TOKEN },
};

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

const ICP_A = "11111111-1111-4111-8111-111111111111";

describe("constantTimeEqual", () => {
	it("accepts two identical strings", () => {
		expect(constantTimeEqual("abc123", "abc123")).toBe(true);
	});

	it("rejects strings of equal length that differ in one byte", () => {
		expect(constantTimeEqual("abc123", "abc124")).toBe(false);
	});

	it("rejects strings of different length without throwing", () => {
		expect(constantTimeEqual("short", "a-lot-longer")).toBe(false);
	});
});

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
		const icpId = "77777777-7777-4777-8777-777777777777";

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
	it("starts a people/find run scoped by icpId", async () => {
		const icpId = "88888888-8888-4888-8888-888888888888";

		const response = await authedCall(
			"/people/find",
			postInit({ icpId }, TOKEN),
		);
		const body: { runId?: string } = await response.json();
		await terminateRun(body.runId);
		const today = new Date().toISOString().slice(0, 10);

		expect(response.status).toBe(202);
		expect(body.runId).toBe(`people_${icpId}_${today}`);
	});

	it("starts an enrich run scoped by the people-find run it enriches", async () => {
		const sourceRun = "people_99999999-9999-4999-8999-999999999999_2026-08-27";

		const response = await authedCall(
			"/enrich",
			postInit({ runId: sourceRun, channels: ["email"] }, TOKEN),
		);
		const body: { runId?: string } = await response.json();
		await terminateRun(body.runId);
		const today = new Date().toISOString().slice(0, 10);

		expect(response.status).toBe(202);
		expect(body.runId).toBe(`enrich_${sourceRun}_${today}`);
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
		const icpId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const started = await authedCall(
			"/companies/find",
			postInit({ icpId, count: 2 }, TOKEN),
		);
		const { runId }: { runId: string } = await started.json();

		const statusResponse = await authedCall(`/runs/${runId}`, authedGetInit());
		const status: { status: string; output?: unknown } =
			await statusResponse.json();

		expect(statusResponse.status).toBe(200);
		expect(typeof status.status).toBe("string");
		expect(status.output == null).toBe(true);
	});
});
