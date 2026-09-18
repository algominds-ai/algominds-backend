import type { Context } from "hono";
import { z } from "zod";
import {
	createIcp,
	findRun,
	loadIcp,
	organizationDomain,
} from "@/core/db/queries";
import { draftIcp, IcpDocSchema } from "@/core/icp";
import type { ApiEnv } from "@/http/auth";
import type { icpRef } from "@/http/schemas";

const CAPABILITIES = ["companies", "people", "enrich", "onboarding"] as const;
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

export const LEGACY_PROFILE_MESSAGE =
	"legacy profile; onboard again with the original targeting instructions";

/** The 409 a start endpoint answers for a stored profile the workflows would reject. */
export function legacyProfileResponse(): Response {
	return Response.json({ error: LEGACY_PROFILE_MESSAGE }, { status: 409 });
}

export type ResolvedProfile = { id: string; legacy: boolean };

/**
 * Uses the given ICP, or stores the free-text prompt as a new one under the
 * organization the caller's key proves. The caller never names it. A stored
 * profile is `legacy` when its document no longer parses — the workflow would
 * reject it, so the endpoint refuses before a run is started.
 */
export async function resolveIcpId(
	env: Env,
	body: IcpRef,
	organizationId: string,
): Promise<ResolvedProfile | null> {
	if ("icpId" in body) {
		const owned = await loadIcp(env, body.icpId);
		if (owned?.organizationId !== organizationId) return null;
		return {
			id: owned.id,
			legacy: !IcpDocSchema.safeParse(owned.doc).success,
		};
	}
	const domain = await organizationDomain(env, organizationId);
	const row = await createIcp(env, {
		doc: draftIcp(domain, body.prompt),
		domain,
		organizationId,
	});
	return { id: row.id, legacy: false };
}

/** Whether `icpId` names a stored profile of this organization whose document no longer parses. */
export async function isLegacyProfile(
	env: Env,
	icpId: string | null | undefined,
	organizationId: string,
): Promise<boolean> {
	if (icpId === null || icpId === undefined) return false;
	const row = await loadIcp(env, icpId);
	if (row === undefined || row.organizationId !== organizationId) return false;
	return !IcpDocSchema.safeParse(row.doc).success;
}

/** Reads a profile only for its owner, including the exact instructions to revise. */
export async function getIcp(
	c: Context<ApiEnv, "/icp/:icpId">,
): Promise<Response> {
	const id = z.uuid().safeParse(c.req.param("icpId"));
	if (!id.success) return c.json({ error: "unknown profile" }, 404);
	const row = await loadIcp(c.env, id.data);
	if (!row || row.organizationId !== c.get("organizationId"))
		return c.json({ error: "unknown profile" }, 404);
	const parsed = IcpDocSchema.safeParse(row.doc);
	if (!parsed.success) return c.json({ error: LEGACY_PROFILE_MESSAGE }, 409);
	return c.json({ icpId: row.id, profile: parsed.data }, 200);
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

/** What an onboarding request names: a domain, and the note when one was given. */
export type OnboardScopeInput = { domain: string; note?: string | undefined };

/**
 * A scope for one onboarding request: the domain and the note together, so a
 * different note is a new run and a repeat of the same note the same day is
 * not. The endpoint and the automatic onboarding started at signup call this
 * with the same shape for a bare domain, so the two never double-charge.
 */
export async function onboardScopeId(
	body: OnboardScopeInput,
	organizationId: string,
): Promise<string> {
	return domainsScopeId([JSON.stringify(body)], organizationId);
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
	workflow: JobWorkflow;
	toJob: (
		body: Body,
		env: Env,
		organizationId: string,
	) => Promise<Job | Response | null>;
};

/** The part of a Workflow binding this file reads: one instance, whether it is still going, and the batch call that creates one. */
type RunLookup = {
	get: (id: string) => Promise<{ status: () => Promise<{ status: string }> }>;
};

type JobWorkflow = RunLookup & {
	createBatch(batch: { id?: string; params?: unknown }[]): Promise<unknown>;
};

const FAILED_STATUSES: ReadonlySet<string> = new Set(["errored", "terminated"]);

/**
 * Whether a run under `runId` is still worth waiting on. A finished or running
 * instance blocks a second start; one that failed does not, because the engine
 * accepts its id again and the caller would otherwise wait for the day to roll.
 * A status that cannot be read counts as blocking, so an unreadable instance
 * never causes a second paid run.
 */
export async function instanceExists(
	workflow: RunLookup,
	runId: string,
): Promise<boolean> {
	let handle: Awaited<ReturnType<RunLookup["get"]>>;
	try {
		handle = await workflow.get(runId);
	} catch {
		return false;
	}
	try {
		return !FAILED_STATUSES.has(String((await handle.status()).status));
	} catch {
		return true;
	}
}

/**
 * Starts `runId` and confirms an instance actually exists afterwards: the
 * production API silently skips a retained id instead of restarting it, so a
 * failed run's id reports "existing" rather than a "started" nothing was
 * behind. Returns true only when a live instance is confirmed.
 */
export async function startInstance(
	workflow: JobWorkflow,
	runId: string,
	params: unknown,
): Promise<boolean> {
	if (await instanceExists(workflow, runId)) return false;
	try {
		await workflow.createBatch([{ id: runId, params }]);
	} catch (error) {
		if (!(await instanceExists(workflow, runId))) throw error;
		return false;
	}
	return instanceExists(workflow, runId);
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
	if (job instanceof Response) return job;
	if (job === null) return c.json({ error: "unknown profile" }, 404);
	if (job.sourceRunId !== undefined) {
		const source = await findRun(c.env, job.sourceRunId);
		if (!source || source.organizationId !== organizationId) {
			return c.json({ error: "unknown run" }, 404);
		}
	}
	const runId = buildRunId(config.capability, job.scopeId);
	const existingResponse = async () => {
		const existing = await findRun(c.env, runId);
		return c.json(
			{ runId, icpId: existing?.icpId ?? job.icpId, status: "existing" },
			200,
		);
	};
	if (!(await startInstance(config.workflow, runId, job.params)))
		return existingResponse();
	return c.json({ runId, icpId: job.icpId, status: "started" }, 202);
}
