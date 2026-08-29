import type { Context } from "hono";
import type { z } from "zod";
import { config } from "@/config";
import { createIcp, findRun, loadIcp } from "@/core/db/queries";
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
 * organization the caller's key proves. The caller never names it.
 */
export async function resolveIcpId(
	env: Env,
	body: IcpRef,
	organizationId: string,
): Promise<string | null> {
	if ("icpId" in body) {
		const owned = await loadIcp(env, body.icpId);
		return owned?.organizationId === organizationId ? owned.id : null;
	}
	const row = await createIcp(env, {
		description: body.prompt,
		domain: config.seller.domain,
		organizationId,
	});
	return row.id;
}

/**
 * A short, stable id for the same set of normalised domains within `owner` on
 * the same day. `owner` is whatever the run belongs to and is never shared
 * across organizations: the caller's organization, or a profile that already
 * proved its owner.
 */
export async function domainsScopeId(
	domains: readonly string[],
	owner: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(`${owner}:${domains.join(",")}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `dom-${hex.slice(0, 12)}`;
}

/** `sourceRunId` names a run this job reads, which the caller must own. */
export type Job = {
	scopeId: string;
	params: unknown;
	icpId?: string;
	sourceRunId?: string;
};

export type JobConfig<Body> = {
	capability: Capability;
	workflow: Workflow<unknown>;
	toJob: (body: Body, env: Env, organizationId: string) => Promise<Job | null>;
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
	const organizationId = c.get("organizationId");
	const job = await config.toJob(parsed.data, c.env, organizationId);
	if (job === null) return c.json({ error: "unknown profile" }, 404);
	if (job.sourceRunId !== undefined) {
		const source = await findRun(c.env, job.sourceRunId);
		if (!source || source.organizationId !== organizationId) {
			return c.json({ error: "unknown run" }, 404);
		}
	}
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
