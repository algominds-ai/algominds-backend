import type { Context } from "hono";
import { z } from "zod";
import { config } from "@/config";
import { findRun, roundsForRun } from "@/core/db/queries";
import { companiesPage, peoplePage } from "@/core/db/run-pages";
import type { Run } from "@/core/db/schema";
import type { ApiEnv } from "@/http/auth";
import { pageQuerySchema } from "@/http/schemas";

export function workflowForCapability(
	env: Env,
	capability: string,
): Workflow<unknown> | undefined {
	if (capability === "companies") return env.FIND_COMPANIES;
	if (capability === "people") return env.FIND_PEOPLE;
	if (capability === "enrich") return env.ENRICH;
	if (capability === "onboarding") return env.ONBOARD_ICP;
	return undefined;
}

/**
 * The run, only when it belongs to the caller's organization. A run owned by
 * another organization reads as unknown rather than forbidden, so the answer
 * never confirms that it exists.
 */
async function callersRun(
	c: Context<ApiEnv>,
	runId: string,
): Promise<Run | undefined> {
	const runRow = await findRun(c.env, runId);
	if (!runRow) return undefined;
	return runRow.organizationId === c.get("organizationId") ? runRow : undefined;
}

const InstanceStatusSchema = z.object({
	status: z.string(),
	output: z
		.object({
			requested: z.number().nullish(),
			found: z.number().nullish(),
			rounds: z.number().nullish(),
			searched: z.number().nullish(),
			peopleFound: z.number().nullish(),
			capped: z.boolean().nullish(),
			icpId: z.string().nullish(),
			wroteProfile: z.boolean().nullish(),
			status: z.string().nullish(),
			roundReports: z.array(z.unknown()).nullish(),
			unknownDomains: z.array(z.string()).nullish(),
			companiesSearched: z.number().nullish(),
			peopleVerified: z.number().nullish(),
			peopleRoster: z.number().nullish(),
			costDollars: z.number().nullish(),
			mode: z.string().nullish(),
			buyerSource: z.string().nullish(),
		})
		.nullish(),
	error: z.unknown().nullish(),
});

/**
 * What a caller is told about a run. `status` answers whether it is still
 * going, and comes from the engine running it. `outcome` answers how it went
 * and is the capability's own word, which is not the same question: a run
 * that ends `short` has finished. The engine's instance object is not passed
 * through, because it carries every step's cached result, which for one ten
 * company run was sixty nine kilobytes of the run's working state.
 */
function runReport(row: Run, instance: unknown) {
	const parsed = InstanceStatusSchema.safeParse(instance);
	const output = parsed.success ? parsed.data.output : undefined;
	return {
		runId: row.id,
		capability: row.capability,
		status: parsed.success ? parsed.data.status : "unknown",
		outcome: row.finishedAt === null ? null : row.status,
		costDollars: row.costDollars,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		...(output ? { summary: output } : {}),
		...(parsed.success &&
		parsed.data.error !== null &&
		parsed.data.error !== undefined
			? { error: parsed.data.error }
			: {}),
	};
}

export async function getRunStatus(
	c: Context<ApiEnv, "/runs/:runId">,
): Promise<Response> {
	const runId = c.req.param("runId");
	const capability = runId.split("_")[0] ?? "";
	const workflow = workflowForCapability(c.env, capability);
	if (!workflow) return c.json({ error: "unknown run" }, 404);
	const row = await callersRun(c, runId);
	if (!row) return c.json({ error: "unknown run" }, 404);
	try {
		const instance = await workflow.get(runId);
		return c.json(runReport(row, await instance.status()), 200);
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
	const runRow = await callersRun(c, runId);
	if (!runRow) return c.json({ error: "unknown run" }, 404);
	const page = await companiesPage(c.env, runRow, query);
	return c.json(
		{ rows: page.rows, nextCursor: page.nextCursor, limit: query.limit },
		200,
	);
}

/** Every round a run recorded: the plan the synthesizer wrote and what that round kept and refused. Read from the database, so it survives the workflow instance the run report reads. */
export async function getRunRounds(
	c: Context<ApiEnv, "/runs/:runId/rounds">,
): Promise<Response> {
	const runId = c.req.param("runId");
	const runRow = await callersRun(c, runId);
	if (!runRow) return c.json({ error: "unknown run" }, 404);
	const rows = await roundsForRun(c.env, runId);
	return c.json({ rows }, 200);
}

export async function getRunPeople(
	c: Context<ApiEnv, "/runs/:runId/people">,
): Promise<Response> {
	const runId = c.req.param("runId");
	const query = parsePageQuery(c);
	if (query instanceof Response) return query;
	const runRow = await callersRun(c, runId);
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
