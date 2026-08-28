import type { Context, Next } from "hono";

export type ApiEnv = { Bindings: Env };

/** Compares two strings by every byte, never stopping at the first mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
	const bytesA = new TextEncoder().encode(a);
	const bytesB = new TextEncoder().encode(b);
	if (bytesA.length !== bytesB.length) return false;
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
	}
	return diff === 0;
}

export async function requireBearerToken(
	c: Context<ApiEnv>,
	next: Next,
): Promise<Response | undefined> {
	const header = c.req.header("authorization") ?? "";
	const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
	const expected = await c.env.API_BEARER_TOKEN.get().catch(() => null);
	const denied =
		!provided || expected === null || !constantTimeEqual(provided, expected);
	if (denied) {
		return c.json({ error: "unauthorized" }, 401);
	}
	await next();
	return undefined;
}
