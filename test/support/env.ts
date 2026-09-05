import { env as testEnv } from "cloudflare:workers";
import type { DbEnv } from "@/core/db/client";

export function fakeDbEnv(cached: string, direct: string): DbEnv {
	return {
		HYPERDRIVE_CACHED: { connectionString: cached },
		HYPERDRIVE_DIRECT: { connectionString: direct },
	};
}

type SecretKey =
	| "EXA_API_KEY"
	| "FINDYMAIL_API_KEY"
	| "CLAY_API_KEY"
	| "GL_API_KEY"
	| "CF_AIG_TOKEN";

/** The worker `Env`, with only the named secret bindings replaced by a fake `get` returning the given value. */
export function fakeSecretEnv(
	secrets: Partial<Record<SecretKey, string>>,
): Env {
	const exa = secrets.EXA_API_KEY;
	const findymail = secrets.FINDYMAIL_API_KEY;
	const clay = secrets.CLAY_API_KEY;
	const aig = secrets.CF_AIG_TOKEN;
	const gl = secrets.GL_API_KEY;
	return {
		...testEnv,
		...(exa !== undefined ? { EXA_API_KEY: { get: async () => exa } } : {}),
		...(findymail !== undefined
			? { FINDYMAIL_API_KEY: { get: async () => findymail } }
			: {}),
		...(clay !== undefined ? { CLAY_API_KEY: { get: async () => clay } } : {}),
		...(aig !== undefined ? { CF_AIG_TOKEN: { get: async () => aig } } : {}),
		...(gl !== undefined ? { GL_API_KEY: { get: async () => gl } } : {}),
	};
}

/** The worker `Env`, wired for an AI Gateway model call under a test gateway base URL and token. */
export function fakeGatewayEnv(overrides: Partial<Env> = {}): Env {
	return {
		...testEnv,
		AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
		CF_AIG_TOKEN: { get: async () => "test-aig-token" },
		MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
		MODEL_ROUTE_WORKER: "dynamic/brain-worker",
		...overrides,
	};
}

type ModelEnvOverrides = {
	AI_GATEWAY_BASE_URL?: string;
	MODEL_ROUTE_REASONING?: string;
	MODEL_ROUTE_WORKER?: string;
};

/**
 * The worker `Env`, with the AI Gateway base url, token, and dynamic model
 * routes pointed at a test gateway. Builds on `base` (the real `Env` by
 * default) rather than always re-spreading it, so composing this with another
 * fake env builder never undoes the other's overrides.
 */
export function fakeModelEnv(
	overrides: ModelEnvOverrides = {},
	base: Env = testEnv,
): Env {
	return {
		...base,
		AI_GATEWAY_BASE_URL:
			overrides.AI_GATEWAY_BASE_URL ?? "https://gateway.test.example/compat",
		CF_AIG_TOKEN: { get: async () => "test-aig-token" },
		MODEL_ROUTE_REASONING:
			overrides.MODEL_ROUTE_REASONING ?? "dynamic/brain-reasoning",
		MODEL_ROUTE_WORKER: overrides.MODEL_ROUTE_WORKER ?? "dynamic/brain-worker",
	};
}
