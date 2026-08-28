import type { Context } from "hono";
import type { z } from "zod";
import { config } from "@/config";
import { createIcp, ensureAccount, findRun } from "@/core/db/queries";
import { normalizeDomain } from "@/core/db/schema";
import type { ApiEnv } from "@/http/auth";
import type { icpRef } from "@/http/schemas";

const CAPABILITIES = ["companies", "people", "enrich"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function todayUtc(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function buildRunId(
	capability: Capability,
	scopeId: string,
	now: Date = new Date(),
): string {
	return `${capability}_${scopeId}_${todayUtc(now)}`;
}

type IcpRef = z.infer<typeof icpRef>;

/**
 * Uses the given ICP, or stores the free-text prompt as a new one under the
 * seller the request names, falling back to the deployment's configured one.
 */
export async function resolveIcpId(env: Env, body: IcpRef): Promise<string> {
	if ("icpId" in body) return body.icpId;
	const domain = normalizeDomain(body.seller?.domain ?? config.seller.domain);
	const name = body.seller?.name ?? body.seller?.domain ?? config.seller.name;
	const sellerAccount = await ensureAccount(env, name, domain);
	const row = await createIcp(env, {
		description: body.prompt,
		domain,
		accountId: sellerAccount.id,
	});
	return row.id;
}

/** A short, stable id for the same set of normalised domains on the same day. */
export async function domainsScopeId(
	domains: readonly string[],
): Promise<string> {
	const bytes = new TextEncoder().encode(domains.join(","));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `dom-${hex.slice(0, 12)}`;
}

export type Job = { scopeId: string; params: unknown; icpId?: string };

export type JobConfig<Body> = {
	capability: Capability;
	workflow: Workflow<unknown>;
	toJob: (body: Body, env: Env) => Promise<Job>;
};

/** Whether an instance already exists for `runId`, per the Workflows engine itself. */
export async function instanceExists(
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

export async function startJob<Body>(
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
