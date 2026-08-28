import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authOptions } from "@/auth-options";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";

/**
 * The auth instance for one request. Built per call because its database
 * client is, and a Workers isolate may not reuse a socket across requests.
 */
export function createAuth(env: DbEnv) {
	return betterAuth({
		...authOptions,
		database: drizzleAdapter(db(env, "cached"), { provider: "pg" }),
	});
}

export type Auth = ReturnType<typeof createAuth>;
