import { config } from "@/config";

export const QUOTE_MAX_BYTES = 1_048_576;

const QUOTE_FETCH_USER_AGENT = "Algominds/1.0 (+https://algominds.ai)";

export type QuoteCheckReason =
	| "found"
	| "missing"
	| `fetch:${number}`
	| "timeout"
	| "unsafe-url";

export type QuoteCheckOutcome = { found: boolean; reason: QuoteCheckReason };

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	nbsp: " ",
};

function normalize(raw: string): string {
	const text = raw
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(
			/&(amp|lt|gt|quot|#39|nbsp);/gi,
			(_m, e: string) => ENTITIES[e.toLowerCase()] ?? " ",
		)
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/ /g, " ");
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isSafeQuoteUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return (
		parsed.protocol === "https:" &&
		parsed.username === "" &&
		parsed.password === ""
	);
}

/** Confirms a quote appears on a page, over a plain https fetch with no manual redirect logic. */
export async function quoteOnPage(
	url: string,
	quote: string,
	env?: Env,
): Promise<QuoteCheckOutcome> {
	if (!isSafeQuoteUrl(url)) return { found: false, reason: "unsafe-url" };
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			headers: { "user-agent": QUOTE_FETCH_USER_AGENT },
			signal: AbortSignal.timeout(config.people.quoteFetchTimeoutMs),
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			return { found: false, reason: "timeout" };
		}
		return { found: false, reason: "fetch:0" };
	}
	if (!response.ok) return { found: false, reason: `fetch:${response.status}` };
	const text = (await response.text()).slice(0, QUOTE_MAX_BYTES);
	const found = normalize(text).includes(normalize(quote));
	return { found, reason: found ? "found" : "missing" };
}
