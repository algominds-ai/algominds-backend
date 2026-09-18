import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { exaFetch, extractRequestId } from "@/core/providers/exa/http";

const EXA_CONTENTS_MAX_CHARACTERS = 20_000;
const EXA_HIGHLIGHTS_MAX_CHARACTERS = 3_000;

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
	query?: string;
	byId?: boolean;
};

const ExaContentsStatusSchema = z.object({
	id: z.string(),
	status: z.enum(["success", "error"]),
	error: z.object({ tag: z.string().optional() }).optional(),
});

const ExaContentsResultSchema = z.object({
	id: z.string().optional(),
	url: z.string(),
	title: z.string().optional(),
	publishedDate: z.string().nullish(),
	text: z.string().optional(),
	highlights: z.array(z.string()).optional(),
});

const ExaContentsResponseSchema = z.object({
	requestId: z.string(),
	results: z.array(ExaContentsResultSchema),
	statuses: z.array(ExaContentsStatusSchema),
	costDollars: z.object({ total: z.number() }),
});

export type ExaContentResult = {
	id?: string;
	url: string;
	title?: string;
	text: string | null;
	publishedDate?: string | null;
};

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
				...(options.byId ? { ids: urls } : { urls }),
				text: options.query
					? true
					: {
							maxCharacters:
								options.maxCharacters ?? EXA_CONTENTS_MAX_CHARACTERS,
						},
				...(options.query
					? {
							highlights: {
								query: options.query,
								maxCharacters: EXA_HIGHLIGHTS_MAX_CHARACTERS,
							},
						}
					: {}),
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
			...(result.id !== undefined && { id: result.id }),
			url: result.url,
			...(result.title ? { title: result.title } : {}),
			text: options.query
				? queryText(
						result.text ?? "",
						result.highlights,
						EXA_HIGHLIGHTS_MAX_CHARACTERS,
						options.maxCharacters ?? EXA_CONTENTS_MAX_CHARACTERS,
					)
				: (result.text ?? null),
			publishedDate: result.publishedDate ?? null,
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

function queryText(
	text: string,
	highlights: readonly string[] | undefined,
	highlightsMaxCharacters: number,
	textMaxCharacters: number,
): string {
	if (text.length <= textMaxCharacters) return text;
	if (!highlights?.length) return text.slice(0, textMaxCharacters);
	const exact = highlights
		.flatMap((highlight) => highlight.split(/\n\.\.\.\n/))
		.filter(
			(highlight) =>
				highlight.trim().length > 0 && quoteFoundInText(text, highlight),
		);
	let size = 0;
	const selected: string[] = [];
	for (const highlight of exact) {
		const nextSize = size + highlight.length + (selected.length > 0 ? 5 : 0);
		if (nextSize > highlightsMaxCharacters) break;
		selected.push(highlight);
		size = nextSize;
	}
	return selected.length > 0
		? selected.join("\n...\n")
		: text.slice(0, textMaxCharacters);
}
