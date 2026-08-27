import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/core/db/schema";

export type DbMode = "cached" | "direct";

// Two Hyperdrive bindings sit in front of one PlanetScale Postgres database
// (wrangler.jsonc). `cached` is the default read path. `direct` disables
// Hyperdrive's cache and is the only mode allowed for a read that must see a
// write made moments earlier (R32, KTD3, AE7) — Hyperdrive does not
// invalidate its cache on write.
//
// The client is built inside this function, on every call, never at module
// scope: Workers bindings such as `env.HYPERDRIVE_DIRECT` do not exist until
// a request is in flight.
export function db(env: Env, mode: DbMode) {
	const hyperdrive =
		mode === "direct" ? env.HYPERDRIVE_DIRECT : env.HYPERDRIVE_CACHED;
	// `max: 5` and `fetch_types: false` are Cloudflare's documented postgres.js
	// settings for a Hyperdrive-fronted connection. The two bindings share one
	// origin connection budget on the PlanetScale side, so keep this small.
	const client = postgres(hyperdrive.connectionString, {
		max: 5,
		fetch_types: false,
	});
	return drizzle(client, { schema });
}

export type Db = ReturnType<typeof db>;
