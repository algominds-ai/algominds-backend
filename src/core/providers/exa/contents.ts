import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { EXA_FETCH_TIMEOUT_MS } from "@/core/providers/exa/timeout";
import { RetryableProviderError } from "@/core/providers/waterfall";

const EXA_CONTENTS_MAX_CHARACTERS = 20_000;

const ExaContentsStatusSchema = z.object({
	id: z.string(),
	status: z.enum(["success", "error"]),
	error: z.object({ tag: z.string() }).optional(),
});

const ExaContentsResultSchema = z.object({
	url: z.string(),
	text: z.string().optional(),
});

const ExaContentsResponseSchema = z.object({
	requestId: z.string(),
	results: z.array(ExaContentsResultSchema),
	statuses: z.array(ExaContentsStatusSchema),
	costDollars: z.object({ total: z.number() }),
});

const ExaErrorSchema = z.object({
	requestId: z.string().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
});

export type ExaContentResult = { url: string; text: string | null };

/** One URL's fetch outcome. `tag` is the vendor's error tag, present only when `status` is `"error"`. */
export type ExaContentStatus = {
	url: string;
	status: "success" | "error";
	tag: string | null;
};

export type ExaContentsResult = {
	requestId: string;
	results: ExaContentResult[];
	statuses: ExaContentStatus[];
};

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return {};
	}
}

function extractRequestId(body: unknown): string | undefined {
	const parsed = ExaErrorSchema.safeParse(body);
	return parsed.success ? parsed.data.requestId : undefined;
}

function throwForStatus(status: number, body: unknown): never {
	const parsed = ExaErrorSchema.safeParse(body);
	const requestId = extractRequestId(body);
	const reason = parsed.success
		? (parsed.data.message ?? parsed.data.error ?? `status ${status}`)
		: `status ${status}`;
	const detail = requestId
		? `Exa contents request failed: ${reason} (requestId ${requestId})`
		: `Exa contents request failed: ${reason}`;
	if (status === 429 || status >= 500) throw new RetryableProviderError(detail);
	throw new NonRetryableError(detail);
}

function parseResponse(
	body: unknown,
): z.infer<typeof ExaContentsResponseSchema> {
	const parsed = ExaContentsResponseSchema.safeParse(body);
	if (parsed.success) return parsed.data;
	const requestId = extractRequestId(body);
	const detail = requestId
		? `Exa contents: response did not match the expected shape (requestId ${requestId})`
		: "Exa contents: response did not match the expected shape";
	throw new NonRetryableError(detail);
}

/**
 * Posts the given URLs to the Exa `/contents` endpoint and returns each URL's
 * crawled text (or its per-URL failure tag), after reporting the response's
 * cost into `ledger`. HTTP 200 covers a per-URL failure; only a transport
 * failure, a 429/5xx, or a malformed body reaches the caller as a thrown error.
 */
export async function exaContents(
	urls: readonly string[],
	env: Env,
	ledger: CostLedger,
): Promise<ExaContentsResult> {
	const apiKey = await env.EXA_API_KEY.get();
	let response: Response;
	try {
		response = await fetch("https://api.exa.ai/contents", {
			method: "POST",
			headers: { "x-api-key": apiKey, "content-type": "application/json" },
			body: JSON.stringify({
				urls,
				text: { maxCharacters: EXA_CONTENTS_MAX_CHARACTERS },
			}),
			signal: AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new RetryableProviderError("Exa contents request timed out");
		}
		throw error;
	}
	const body = await readJson(response);
	if (!response.ok) throwForStatus(response.status, body);
	const parsed = parseResponse(body);
	ledger.reported("exa", "contents", parsed.costDollars.total);
	return {
		requestId: parsed.requestId,
		results: parsed.results.map((result) => ({
			url: result.url,
			text: result.text ?? null,
		})),
		statuses: parsed.statuses.map((status) => ({
			url: status.id,
			status: status.status,
			tag: status.error?.tag ?? null,
		})),
	};
}
