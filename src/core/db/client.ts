import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/core/db/schema";

export type DbMode = "cached" | "direct";

export type DbEnv = {
	readonly HYPERDRIVE_CACHED: Pick<Hyperdrive, "connectionString">;
	readonly HYPERDRIVE_DIRECT: Pick<Hyperdrive, "connectionString">;
};

/**
 * Builds a fresh Drizzle client bound to one of the two Hyperdrive
 * configurations. Fresh per call on purpose: a Workers isolate may not reuse
 * a socket opened in another request. One connection is enough for one call,
 * and an idle one is given back rather than held. See
 * `docs/solutions/dedupe-read-cache-consistency.md`.
 */
export function db(env: DbEnv, mode: DbMode) {
	const hyperdrive =
		mode === "direct" ? env.HYPERDRIVE_DIRECT : env.HYPERDRIVE_CACHED;
	const client = postgres(hyperdrive.connectionString, {
		max: 1,
		idle_timeout: 20,
		fetch_types: false,
	});
	return drizzle(client, { schema });
}

export type Db = ReturnType<typeof db>;
