import { createMiddleware } from "hono/factory";
import { createAuth } from "@/auth";
import { ORGANIZATION_KEY_CONFIG_ID } from "@/auth-options";

export type ApiEnv = {
	Bindings: Env;
	Variables: { organizationId: string };
};

const API_KEY_HEADER = "x-api-key";
const BEARER = "Bearer ";

function presentedKey(
	header: string | undefined,
	authorization: string,
): string {
	if (header) return header;
	return authorization.startsWith(BEARER)
		? authorization.slice(BEARER.length)
		: "";
}

/**
 * Resolves the organization a request belongs to from the key it presents.
 * The organization is never taken from the request body, so a caller can only
 * ever act on the tenant its credential proves. A key that does not verify is
 * refused; anything else is allowed to throw, because an auth surface that
 * cannot answer must fail loudly rather than refuse everyone in silence.
 */
export const requireApiKey = createMiddleware<ApiEnv>(async (c, next) => {
	const key = presentedKey(
		c.req.header(API_KEY_HEADER),
		c.req.header("authorization") ?? "",
	);
	if (!key) return c.json({ error: "unauthorized" }, 401);

	const verified = await createAuth(c.env).api.verifyApiKey({
		body: { key, configId: ORGANIZATION_KEY_CONFIG_ID },
	});

	const organizationId = verified.valid ? verified.key?.referenceId : undefined;
	if (!organizationId) return c.json({ error: "unauthorized" }, 401);

	c.set("organizationId", organizationId);
	await next();
	return undefined;
});
