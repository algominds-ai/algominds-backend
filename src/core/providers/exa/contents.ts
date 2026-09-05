import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { exaFetch, extractRequestId } from "@/core/providers/exa/http";

const EXA_CONTENTS_MAX_CHARACTERS = 20_000;

const EXA_LIVECRAWL_OPTIONS = [
	"always",
	"fallback",
	"never",
	"preferred",
] as const;

export type ExaLivecrawl = (typeof EXA_LIVECRAWL_OPTIONS)[number];

export type ExaContentsOptions = {
	maxCharacters?: number;
	livecrawl?: ExaLivecrawl;
};

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
 * cost into `ledger`. `options.maxCharacters` defaults to 20000 and
 * `options.livecrawl` is left to the vendor's own default when omitted. HTTP
 * 200 covers a per-URL failure; only a transport failure, a 429/5xx, or a
 * malformed body reaches the caller as a thrown error.
 */
export async function exaContents(
	urls: readonly string[],
	env: Env,
	ledger: CostLedger,
	options: ExaContentsOptions = {},
): Promise<ExaContentsResult> {
	const apiKey = await env.EXA_API_KEY.get();
	const body = await exaFetch(
		"https://api.exa.ai/contents",
		{
			method: "POST",
			headers: { "x-api-key": apiKey, "content-type": "application/json" },
			body: JSON.stringify({
				urls,
				text: {
					maxCharacters: options.maxCharacters ?? EXA_CONTENTS_MAX_CHARACTERS,
				},
				...(options.livecrawl ? { livecrawl: options.livecrawl } : {}),
			}),
		},
		"Exa contents",
		"Exa contents request timed out",
	);
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

function collapseWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/** Whether `quote` appears in `text`, ignoring case and collapsing whitespace so a crawl-inserted line break does not break a match. */
export function quoteFoundInText(text: string, quote: string): boolean {
	return collapseWhitespace(text)
		.toLowerCase()
		.includes(collapseWhitespace(quote).toLowerCase());
}

/** `"found"` or `"missing"` when the page fetched cleanly, else the vendor's error tag for that URL. */
export type QuoteCheckReason = string;

export type QuoteCheckOutcome = { found: boolean; reason: QuoteCheckReason };

/**
 * Confirms a quote appears on a page, over Exa's `/contents` crawl rather
 * than a direct fetch. A crawl failure reports its vendor tag as the reason;
 * otherwise the reason is `"found"` or `"missing"`.
 */
export async function quoteOnPage(
	url: string,
	quote: string,
	env: Env,
	ledger: CostLedger,
): Promise<QuoteCheckOutcome> {
	const contents = await exaContents([url], env, ledger);
	const status = contents.statuses[0];
	if (status?.status === "error") {
		return { found: false, reason: status.tag ?? "CRAWL_UNKNOWN_ERROR" };
	}
	const text = contents.results[0]?.text ?? "";
	const found = quoteFoundInText(text, quote);
	return { found, reason: found ? "found" : "missing" };
}
