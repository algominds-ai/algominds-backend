import type { Context } from "hono";
import { config } from "@/config";
import { findRun } from "@/core/db/queries";
import { companiesPage, peoplePage } from "@/core/db/run-pages";
import type { ApiEnv } from "@/http/auth";
import { pageQuerySchema } from "@/http/schemas";

export function workflowForCapability(
	env: Env,
	capability: string,
): Workflow<unknown> | undefined {
	if (capability === "companies") return env.FIND_COMPANIES;
	if (capability === "people") return env.FIND_PEOPLE;
	if (capability === "enrich") return env.ENRICH;
	return undefined;
}

export async function getRunStatus(
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

type PageQuery = { limit: number; cursor: string | undefined };

/** The caller's own limit, up to the configured page-size ceiling. */
export function effectiveLimit(requested: number | undefined): number {
	return Math.min(
		requested ?? config.limits.maxRunPageSize,
		config.limits.maxRunPageSize,
	);
}

export function parsePageQuery(c: Context<ApiEnv>): PageQuery | Response {
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

export async function getRunCompanies(
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

export async function getRunPeople(
	c: Context<ApiEnv, "/runs/:runId/people">,
): Promise<Response> {
	const runId = c.req.param("runId");
	const query = parsePageQuery(c);
	if (query instanceof Response) return query;
	const runRow = await findRun(c.env, runId);
	if (!runRow) return c.json({ error: "unknown run" }, 404);
	if (runRow.capability !== "companies" && runRow.capability !== "people") {
		return c.json(
			{ error: `a ${runRow.capability} run holds no people of its own` },
			400,
		);
	}
	const page = await peoplePage(c.env, runRow, query);
	return c.json(
		{ rows: page.rows, nextCursor: page.nextCursor, limit: query.limit },
		200,
	);
}
