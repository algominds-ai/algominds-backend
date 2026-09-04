import { env as testEnv } from "cloudflare:workers";
import type { DbEnv } from "@/core/db/client";

export function fakeDbEnv(cached: string, direct: string): DbEnv {
	return {
		HYPERDRIVE_CACHED: { connectionString: cached },
		HYPERDRIVE_DIRECT: { connectionString: direct },
	};
}

type SecretKey = "EXA_API_KEY" | "FINDYMAIL_API_KEY" | "CLAY_API_KEY";

/** The worker `Env`, with only the named secret bindings replaced by a fake `get` returning the given value. */
export function fakeSecretEnv(
	secrets: Partial<Record<SecretKey, string>>,
): Env {
	const exa = secrets.EXA_API_KEY;
	const findymail = secrets.FINDYMAIL_API_KEY;
	const clay = secrets.CLAY_API_KEY;
	return {
		...testEnv,
		...(exa !== undefined ? { EXA_API_KEY: { get: async () => exa } } : {}),
		...(findymail !== undefined
			? { FINDYMAIL_API_KEY: { get: async () => findymail } }
			: {}),
		...(clay !== undefined ? { CLAY_API_KEY: { get: async () => clay } } : {}),
	};
}
