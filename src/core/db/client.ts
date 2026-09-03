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
 * a socket opened in another request. The caller ends it once its unit of
 * work is done, through `withConnection` for a one-shot call or its own
 * `$client.end()` otherwise. See `docs/solutions/dedupe-read-cache-consistency.md`.
 */
export function db(env: DbEnv, mode: DbMode) {
	const hyperdrive =
		mode === "direct" ? env.HYPERDRIVE_DIRECT : env.HYPERDRIVE_CACHED;
	const client = postgres(hyperdrive.connectionString, {
		max: 1,
		idle_timeout: 3,
		fetch_types: false,
	});
	return drizzle(client, { schema });
}

export type Db = ReturnType<typeof db>;

export type DbFactory<TConnection> = (env: DbEnv, mode: DbMode) => TConnection;

interface RawClient {
	$client: { end(options?: { timeout?: number }): Promise<void> };
}

function hasRawClient<TConnection>(
	connection: TConnection,
): connection is TConnection & RawClient {
	return (
		typeof connection === "object" &&
		connection !== null &&
		"$client" in connection
	);
}

/**
 * Builds one connection for one unit of work, runs `run` against it, then
 * ends the client it built. A connection injected by a test double carries
 * no `$client` and is left alone.
 */
export async function withConnection<TConnection, T>(
	env: DbEnv,
	mode: DbMode,
	buildDb: DbFactory<TConnection>,
	run: (connection: TConnection) => Promise<T>,
): Promise<T> {
	const connection = buildDb(env, mode);
	try {
		return await run(connection);
	} finally {
		if (hasRawClient(connection)) await connection.$client.end();
	}
}
