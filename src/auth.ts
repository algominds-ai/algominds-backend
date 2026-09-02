import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { z } from "zod";
import { authOptions, buildPlugins } from "@/auth-options";
import * as authSchema from "@/core/db/auth-schema";
import type { Db } from "@/core/db/client";
import { db } from "@/core/db/client";
import { publicDomain } from "@/core/db/schema";
import { buildRunId, domainsScopeId } from "@/http/jobs";

const CreatedOrganizationSchema = z.object({
	id: z.string().min(1),
	domain: z.string().nullish(),
});

/** The organization's domain as a hostname worth crawling, or null when it named none or named something else. */
function onboardableDomain(value: string | null | undefined): string | null {
	return value ? publicDomain(value) : null;
}

/**
 * Starts onboarding for an organization that named a domain. Never throws:
 * an account without a profile is recoverable through the endpoint, and an
 * account that fails to be created is not.
 */
export async function startOnboarding(
	env: Env,
	created: unknown,
): Promise<void> {
	const parsed = CreatedOrganizationSchema.safeParse(created);
	if (!parsed.success) return;
	const domain = onboardableDomain(parsed.data.domain);
	if (domain === null) return;
	const organizationId = parsed.data.id;
	try {
		const scopeId = await domainsScopeId([domain], organizationId);
		await env.ONBOARD_ICP.createBatch([
			{
				id: buildRunId("onboarding", scopeId),
				params: { domain, note: null, organizationId },
			},
		]);
	} catch (error) {
		console.error(
			`onboarding failed to start for organization ${organizationId}`,
			error,
		);
	}
}

/**
 * The auth instance for one request, over a connection the caller already
 * opened and owns the lifetime of.
 */
export function createAuthWith(env: Env, connection: Db) {
	return betterAuth({
		...authOptions,
		plugins: buildPlugins((data) => startOnboarding(env, data.organization)),
		database: drizzleAdapter(connection, {
			provider: "pg",
			schema: authSchema,
		}),
	});
}

/**
 * The auth instance for one request, over a connection built and owned for
 * this call. Built per call because its database client is, and a Workers
 * isolate may not reuse a socket across requests.
 */
export function createAuth(env: Env) {
	return createAuthWith(env, db(env, "cached"));
}

export type Auth = ReturnType<typeof createAuth>;
