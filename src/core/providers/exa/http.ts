import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { RetryableProviderError } from "@/core/providers/waterfall";

/**
 * Shared abort timeout for every direct outbound call this engine waits on
 * synchronously: Exa's agent and search endpoints, and every structured
 * model call through the AI Gateway. One durable step pays for at most one
 * of these before it must give up and let the caller decide what a timeout
 * means.
 */
export const EXA_FETCH_TIMEOUT_MS = 60_000;

const ExaErrorSchema = z.object({
	requestId: z.string().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
});

/** Reads a fetch `Response` body as JSON, or `{}` when it is not valid JSON. */
export async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return {};
	}
}

/** The vendor's `requestId` from an Exa error body, when the body carries one. */
export function extractRequestId(body: unknown): string | undefined {
	const parsed = ExaErrorSchema.safeParse(body);
	return parsed.success ? parsed.data.requestId : undefined;
}

/**
 * Throws for a non-2xx Exa response: `RetryableProviderError` on 429 or 5xx,
 * Cloudflare's `NonRetryableError` otherwise. `label` names the call
 * (`"Exa"`, `"Exa contents"`, `"Exa agent"`) in the thrown message, which
 * also carries the vendor's `requestId` when the body reports one.
 */
export function throwForStatus(
	label: string,
	status: number,
	body: unknown,
): never {
	const parsed = ExaErrorSchema.safeParse(body);
	const requestId = extractRequestId(body);
	const reason = parsed.success
		? (parsed.data.message ?? parsed.data.error ?? `status ${status}`)
		: `status ${status}`;
	const detail = requestId
		? `${label} request failed: ${reason} (requestId ${requestId})`
		: `${label} request failed: ${reason}`;
	if (status === 429 || status >= 500) throw new RetryableProviderError(detail);
	throw new NonRetryableError(detail);
}
