import type { Context, Next } from "hono";
import { Hono } from "hono";
import { z } from "zod";

type ApiEnv = { Bindings: Env };

const CAPABILITIES = ["companies", "people", "enrich"] as const;
type Capability = (typeof CAPABILITIES)[number];

function todayUtc(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function buildRunId(
	capability: Capability,
	scopeId: string,
	now: Date = new Date(),
): string {
	return `${capability}_${scopeId}_${todayUtc(now)}`;
}

/** Compares two strings by every byte, never stopping at the first mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
	const bytesA = new TextEncoder().encode(a);
	const bytesB = new TextEncoder().encode(b);
	if (bytesA.length !== bytesB.length) return false;
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
	}
	return diff === 0;
}

async function requireBearerToken(
	c: Context<ApiEnv>,
	next: Next,
): Promise<Response | undefined> {
	const header = c.req.header("authorization") ?? "";
	const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
	const expected = await c.env.API_BEARER_TOKEN.get().catch(() => null);
	const denied =
		!provided || expected === null || !constantTimeEqual(provided, expected);
	if (denied) {
		return c.json({ error: "unauthorized" }, 401);
	}
	await next();
	return undefined;
}

const companiesFindSchema = z.object({
	icpId: z.uuid(),
	count: z.number().int().positive(),
});

const peopleFindSchema = z.object({
	icpId: z.uuid(),
	maxCompanies: z.number().int().positive().max(100).optional(),
});

const enrichSchema = z.object({
	personId: z.uuid(),
	channels: z.array(z.enum(["email", "linkedin"])).min(1),
});

type JobConfig<Body> = {
	capability: Capability;
	workflow: Workflow<unknown>;
	scopeId: (body: Body) => string;
};

async function startJob<Body>(
	c: Context<ApiEnv>,
	schema: z.ZodType<Body>,
	config: JobConfig<Body>,
): Promise<Response> {
	const raw = await c.req.json<unknown>().catch(() => null);
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ issues: parsed.error.issues }, 400);
	}
	const runId = buildRunId(config.capability, config.scopeId(parsed.data));
	await config.workflow.createBatch([{ id: runId, params: parsed.data }]);
	return c.json({ runId }, 202);
}

function workflowForCapability(
	env: Env,
	capability: string,
): Workflow<unknown> | undefined {
	if (capability === "companies") return env.FIND_COMPANIES;
	if (capability === "people") return env.FIND_PEOPLE;
	if (capability === "enrich") return env.ENRICH;
	return undefined;
}

async function getRunStatus(
	c: Context<ApiEnv, "/runs/:runId">,
): Promise<Response> {
	const runId = c.req.param("runId");
	const capability = runId.split("_")[0] ?? "";
	const workflow = workflowForCapability(c.env, capability);
	if (!workflow) return c.json({ error: "unknown run" }, 404);
	try {
		const instance = await workflow.get(runId);
		return c.json(await instance.status(), 200);
	} catch {
		return c.json({ error: "unknown run" }, 404);
	}
}

/** The bearer-protected job API: three start routes plus one status route. */
export function createApiRoutes(): Hono<ApiEnv> {
	const api = new Hono<ApiEnv>();
	api.use("*", requireBearerToken);

	api.post("/companies/find", (c) =>
		startJob(c, companiesFindSchema, {
			capability: "companies",
			workflow: c.env.FIND_COMPANIES,
			scopeId: (body) => body.icpId,
		}),
	);

	api.post("/people/find", (c) =>
		startJob(c, peopleFindSchema, {
			capability: "people",
			workflow: c.env.FIND_PEOPLE,
			scopeId: (body) => body.icpId,
		}),
	);

	api.post("/enrich", (c) =>
		startJob(c, enrichSchema, {
			capability: "enrich",
			workflow: c.env.ENRICH,
			scopeId: (body) => body.personId,
		}),
	);

	api.get("/runs/:runId", getRunStatus);

	return api;
}
