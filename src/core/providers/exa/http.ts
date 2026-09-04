import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import { RetryableProviderError } from "@/core/providers/waterfall";

/**
 * Shared abort timeout for every direct outbound call this engine waits on
 * synchronously against Exa: its agent, search, and contents endpoints. A
 * structured model call through the AI Gateway carries its own timeout,
 * `config.model.timeoutMs`, since a judge call reasoning over a batch of
 * rows needs longer than a plain vendor fetch. One durable step pays for at
 * most one of these before it must give up and let the caller decide what a
 * timeout means.
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(header: string | null): number {
	if (header === null) return 1000;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000;
	const dateMs = Date.parse(header);
	return Number.isNaN(dateMs) ? 1000 : Math.max(dateMs - Date.now(), 0);
}

async function requestOnce(
	url: string,
	init: RequestInit,
	timeoutMessage: string,
): Promise<Response> {
	try {
		return await fetch(url, {
			...init,
			signal: AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new RetryableProviderError(timeoutMessage);
		}
		throw error;
	}
}

/**
 * Fetches one Exa endpoint (search, contents, agent create, agent poll). A
 * 429 waits once for its `Retry-After` header (or one second when absent),
 * capped at `config.companies.exaRetryAfterMaxMs`, then repeats the identical
 * request once; a second 429 throws `RetryableProviderError` exactly as any
 * other non-2xx status would through `throwForStatus`. `label` names the call
 * the same way `throwForStatus` does, and `timeoutMessage` is what a transport
 * timeout on either attempt throws.
 */
export async function exaFetch(
	url: string,
	init: RequestInit,
	label: string,
	timeoutMessage: string,
): Promise<unknown> {
	const first = await requestOnce(url, init, timeoutMessage);
	if (first.status !== 429) {
		const body = await readJson(first);
		if (!first.ok) throwForStatus(label, first.status, body);
		return body;
	}
	const waitMs = Math.min(
		retryAfterMs(first.headers.get("retry-after")),
		config.companies.exaRetryAfterMaxMs,
	);
	await sleep(waitMs);
	const retried = await requestOnce(url, init, timeoutMessage);
	const body = await readJson(retried);
	if (!retried.ok) throwForStatus(label, retried.status, body);
	return body;
}
