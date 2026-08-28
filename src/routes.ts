import type { Context, Next } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "@/config";
import { createIcp, ensureAccount, findRun } from "@/core/db/queries";
import { companiesPage, peoplePage } from "@/core/db/run-pages";
import { normalizeDomain } from "@/core/db/schema";

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

const SELLER_DOMAIN = "algominds.ai";

const icpRef = z.union([
	z.object({ icpId: z.uuid() }),
	z.object({ prompt: z.string().min(1) }),
]);

const companiesFindSchema = z.intersection(
	icpRef,
	z.object({
		count: z
			.number()
			.int()
			.positive()
			.max(config.limits.maxCompaniesPerRequest),
	}),
);

function normalizedDomainList(
	values: string[],
	ctx: z.RefinementCtx,
): string[] {
	const normalized = values.map((value) => {
		try {
			return normalizeDomain(value);
		} catch {
			ctx.addIssue({ code: "custom", message: `not a valid domain: ${value}` });
			return value;
		}
	});
	return [...new Set(normalized)].sort();
}

const domainsField = z
	.array(z.string().min(1))
	.min(1)
	.max(config.limits.maxCompaniesPerPeopleRun)
	.transform(normalizedDomainList);

const maxCompaniesField = z.number().int().positive().optional();

const peopleFindSchema = z.union([
	z.strictObject({ runId: z.string().min(1), maxCompanies: maxCompaniesField }),
	z.strictObject({ domains: domainsField, maxCompanies: maxCompaniesField }),
]);

/** A short, stable id for the same set of normalised domains on the same day. */
async function domainsScopeId(domains: readonly string[]): Promise<string> {
	const bytes = new TextEncoder().encode(domains.join(","));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `dom-${hex.slice(0, 12)}`;
}

const enrichSchema = z.object({
	runId: z.string(),
	channels: z.array(z.enum(["email", "linkedin"])).min(1),
});

type IcpRef = z.infer<typeof icpRef>;

/** Uses the given ICP, or stores the free-text prompt as a new one. */
async function resolveIcpId(env: Env, body: IcpRef): Promise<string> {
	if ("icpId" in body) return body.icpId;
	const sellerAccount = await ensureAccount(env, SELLER_DOMAIN, SELLER_DOMAIN);
	const row = await createIcp(env, {
		description: body.prompt,
		domain: SELLER_DOMAIN,
		accountId: sellerAccount.id,
	});
	return row.id;
}

type Job = { scopeId: string; params: unknown; icpId?: string };

type JobConfig<Body> = {
	capability: Capability;
	workflow: Workflow<unknown>;
	toJob: (body: Body, env: Env) => Promise<Job>;
};

/** Whether an instance already exists for `runId`, per the Workflows engine itself. */
async function instanceExists(
	workflow: Workflow<unknown>,
	runId: string,
): Promise<boolean> {
	try {
		await workflow.get(runId);
		return true;
	} catch {
		return false;
	}
}

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
	const job = await config.toJob(parsed.data, c.env);
	const runId = buildRunId(config.capability, job.scopeId);
	if (await instanceExists(config.workflow, runId)) {
		const existing = await findRun(c.env, runId);
		return c.json(
			{ runId, icpId: existing?.icpId ?? job.icpId, status: "existing" },
			200,
		);
	}
	await config.workflow.createBatch([{ id: runId, params: job.params }]);
	return c.json({ runId, icpId: job.icpId, status: "started" }, 202);
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

const pageQuerySchema = z.object({
	limit: z.coerce.number().int().positive().optional(),
	cursor: z.uuid().optional(),
});

type PageQuery = { limit: number; cursor: string | undefined };

/** The caller's own limit, up to the configured page-size ceiling. */
function effectiveLimit(requested: number | undefined): number {
	return Math.min(
		requested ?? config.limits.maxRunPageSize,
		config.limits.maxRunPageSize,
	);
}

function parsePageQuery(c: Context<ApiEnv>): PageQuery | Response {
	const parsed = pageQuerySchema.safeParse({
		limit: c.req.query("limit"),
		cursor: c.req.query("cursor"),
	});
	if (!parsed.success) return c.json({ issues: parsed.error.issues }, 400);
	return {
		limit: effectiveLimit(parsed.data.limit),
		cursor: parsed.data.cursor,
	};
}

async function getRunCompanies(
	c: Context<ApiEnv, "/runs/:runId/companies">,
): Promise<Response> {
	const runId = c.req.param("runId");
	const query = parsePageQuery(c);
	if (query instanceof Response) return query;
	const runRow = await findRun(c.env, runId);
	if (!runRow) return c.json({ error: "unknown run" }, 404);
	const page = await companiesPage(c.env, runId, query);
	return c.json(
		{ rows: page.rows, nextCursor: page.nextCursor, limit: query.limit },
		200,
	);
}

async function getRunPeople(
	c: Context<ApiEnv, "/runs/:runId/people">,
): Promise<Response> {
	const runId = c.req.param("runId");
	const query = parsePageQuery(c);
	if (query instanceof Response) return query;
	const runRow = await findRun(c.env, runId);
	if (!runRow) return c.json({ error: "unknown run" }, 404);
	const page = await peoplePage(c.env, runId, query);
	return c.json(
		{ rows: page.rows, nextCursor: page.nextCursor, limit: query.limit },
		200,
	);
}

/** The bearer-protected job API: three start routes plus one status route. */
export function createApiRoutes(): Hono<ApiEnv> {
	const api = new Hono<ApiEnv>();
	api.use("*", requireBearerToken);

	api.post("/companies/find", (c) =>
		startJob(c, companiesFindSchema, {
			capability: "companies",
			workflow: c.env.FIND_COMPANIES,
			toJob: async (body, env) => {
				const icpId = await resolveIcpId(env, body);
				return { scopeId: icpId, icpId, params: { icpId, count: body.count } };
			},
		}),
	);

	api.post("/people/find", (c) =>
		startJob(c, peopleFindSchema, {
			capability: "people",
			workflow: c.env.FIND_PEOPLE,
			toJob: async (body) => {
				if ("runId" in body) {
					return {
						scopeId: body.runId,
						params: { runId: body.runId, maxCompanies: body.maxCompanies },
					};
				}
				return {
					scopeId: await domainsScopeId(body.domains),
					params: { domains: body.domains, maxCompanies: body.maxCompanies },
				};
			},
		}),
	);

	api.post("/enrich", (c) =>
		startJob(c, enrichSchema, {
			capability: "enrich",
			workflow: c.env.ENRICH,
			toJob: async (body) => ({ scopeId: body.runId, params: body }),
		}),
	);

	api.get("/runs/:runId", getRunStatus);
	api.get("/runs/:runId/companies", getRunCompanies);
	api.get("/runs/:runId/people", getRunPeople);

	return api;
}
