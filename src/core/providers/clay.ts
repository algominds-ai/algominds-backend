import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import type { CostLedger } from "@/core/cost";
import { RetryableProviderError } from "@/core/providers/waterfall";

const CLAY_BASE_URL = "https://api.clay.com/public/v0";
const CLAY_MAX_PAGES = 5;
const CLAY_RUN_LIMIT = 500;

export type ClaySearchInput = {
	identifier: string;
};

export type ClayRow = {
	name: string | null;
	title: string | null;
	company: string | null;
	url: string | null;
	location: string | null;
	since: string | null;
};

export type ClaySearchResult = {
	rows: ClayRow[];
	raw: string[];
	quotaUsed: number;
	rejected: boolean;
	capped: boolean;
	error?: string;
};

type ClaySearchCreateRequest = {
	source_type: "people";
	filters: { company_identifier: string[] };
};

const ClaySearchCreateResponseSchema = z
	.object({ search_id: z.string() })
	.passthrough();

const ClaySearchRowSchema = z
	.object({
		name: z.string().nullish(),
		url: z.string().nullish(),
		latest_experience_title: z.string().nullish(),
		latest_experience_company: z.string().nullish(),
		latest_experience_start_date: z.string().nullish(),
		matched_experience: z
			.object({
				job_title: z.string().nullish(),
				company_name: z.string().nullish(),
				start_date: z.string().nullish(),
			})
			.nullish()
			.catch(null),
		location: z.string().nullish(),
		structured_location: z
			.object({ city: z.string().nullish(), country: z.string().nullish() })
			.nullish(),
	})
	.passthrough();

const ClaySearchRunResponseSchema = z
	.object({
		data: z.array(ClaySearchRowSchema),
		has_more: z.boolean(),
		period_quota: z.object({ used: z.number() }).nullish(),
	})
	.passthrough();

type ClayFetchContext = { apiKey: string; timeoutMs: number };

/** Canonical LinkedIn profile URL after validating the actual host and profile path. */
export function canonicalPersonUrl(
	raw: string | null | undefined,
): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
		const host = url.hostname.toLowerCase();
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.port
		)
			return null;
		if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
		const parts = url.pathname.split("/").filter(Boolean);
		return parts.length === 2 && parts[0] === "in" && parts[1]
			? `https://linkedin.com/in/${parts[1].toLowerCase()}`
			: null;
	} catch {
		return null;
	}
}

function structuredLocation(
	value: z.infer<typeof ClaySearchRowSchema>["structured_location"],
): string | null {
	const parts = [value?.city, value?.country].filter((part): part is string =>
		Boolean(part),
	);
	return parts.length > 0 ? parts.join(", ") : null;
}

function toClayRow(row: z.infer<typeof ClaySearchRowSchema>): ClayRow {
	return {
		name: row.name ?? null,
		title:
			row.matched_experience?.job_title ?? row.latest_experience_title ?? null,
		company:
			row.matched_experience?.company_name ??
			row.latest_experience_company ??
			null,
		url: canonicalPersonUrl(row.url),
		location: row.location ?? structuredLocation(row.structured_location),
		since:
			row.matched_experience?.start_date ??
			row.latest_experience_start_date ??
			null,
	};
}

type PostClayOutcome = { text: string; rejected: boolean };

async function requestClay(
	path: string,
	body: unknown,
	ctx: ClayFetchContext,
): Promise<Response> {
	try {
		return await fetch(`${CLAY_BASE_URL}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"clay-api-key": ctx.apiKey,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(ctx.timeoutMs),
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new RetryableProviderError(`Clay request to ${path} timed out`);
		}
		throw error;
	}
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

async function interpretClayResponse(
	path: string,
	response: Response,
	allowRejection: boolean,
): Promise<PostClayOutcome> {
	if (response.status === 429 || response.status >= 500) {
		throw new RetryableProviderError(
			`Clay request to ${path} failed: status ${response.status}`,
		);
	}
	if (response.status === 400 && allowRejection) {
		return { text: await response.text(), rejected: true };
	}
	if (!response.ok) {
		throw new NonRetryableError(
			`Clay request to ${path} failed: status ${response.status}`,
		);
	}
	return { text: await response.text(), rejected: false };
}

/**
 * Posts one Clay request. A 429 waits once for Clay's `Retry-After` (a
 * fixed second when absent), capped at `config.people.clayRetryAfterMaxMs`,
 * then repeats the same request once; a second 429 throws
 * `RetryableProviderError` exactly as a first 429 would. Bounded by that
 * capped wait plus two request timeouts of `ctx.timeoutMs`.
 */
async function postClay(
	path: string,
	body: unknown,
	ctx: ClayFetchContext,
	options?: { allowRejection: boolean },
): Promise<PostClayOutcome> {
	const allowRejection = options?.allowRejection ?? false;
	const response = await requestClay(path, body, ctx);
	if (response.status !== 429) {
		return interpretClayResponse(path, response, allowRejection);
	}
	const waitMs = Math.min(
		retryAfterMs(response.headers.get("retry-after")),
		config.people.clayRetryAfterMaxMs,
	);
	await sleep(waitMs);
	const retried = await requestClay(path, body, ctx);
	return interpretClayResponse(path, retried, allowRejection);
}

function parseJson(text: string, whatFailed: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new NonRetryableError(`Clay: ${whatFailed} was not JSON`);
	}
}

async function createSearch(
	input: ClaySearchInput,
	ctx: ClayFetchContext,
): Promise<{ searchId: string; raw: string }> {
	const request: ClaySearchCreateRequest = {
		source_type: "people",
		filters: { company_identifier: [input.identifier] },
	};
	const { text } = await postClay("/search/filters-mode", request, ctx);
	const parsed = ClaySearchCreateResponseSchema.safeParse(
		parseJson(text, "create response"),
	);
	if (!parsed.success) {
		throw new NonRetryableError(
			"Clay: create response did not match the expected shape",
		);
	}
	return { searchId: parsed.data.search_id, raw: text };
}

type RunPageResult =
	| { rejected: true; raw: string }
	| {
			rejected: false;
			page: z.infer<typeof ClaySearchRunResponseSchema>;
			raw: string;
	  };

async function runPage(
	searchId: string,
	ctx: ClayFetchContext,
): Promise<RunPageResult> {
	const outcome = await postClay(
		`/search/filters-mode/${searchId}/run`,
		{ limit: CLAY_RUN_LIMIT },
		ctx,
		{ allowRejection: true },
	);
	if (outcome.rejected) return { rejected: true, raw: outcome.text };
	const parsed = ClaySearchRunResponseSchema.safeParse(
		parseJson(outcome.text, "run response"),
	);
	if (!parsed.success) {
		throw new NonRetryableError(
			"Clay: run response did not match the expected shape",
		);
	}
	return { rejected: false, page: parsed.data, raw: outcome.text };
}

function quotaDelta(
	start: number | null,
	end: number | null,
	rows: number,
): number {
	if (start === null || end === null) return rows;
	return Math.max(end - start, rows);
}

function partialPageError(
	error: unknown,
	priorRows: number,
): { error: string } {
	if (priorRows === 0) throw error;
	return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * Runs Clay's two-step people search over `input.identifier`, paging the
 * created search until `has_more` is false or the code-level page ceiling is
 * reached, and returns the mapped rows alongside every untouched reply body.
 * A 400 on the run call after a successful create means Clay rejected the
 * identifier; that page's clean-empty result carries `rejected: true`.
 */
export async function claySearch(
	env: Env,
	input: ClaySearchInput,
	ledger: CostLedger,
): Promise<ClaySearchResult> {
	const ctx: ClayFetchContext = {
		apiKey: await env.CLAY_API_KEY.get(),
		timeoutMs: config.people.clayFetchTimeoutMs,
	};
	const created = await createSearch(input, ctx);
	const raw = [created.raw];
	let rows: ClayRow[] = [];
	let quotaStart: number | null = null;
	let capped = false;
	let quotaEnd: number | null = null;
	for (let page = 0; page < CLAY_MAX_PAGES; page++) {
		const result = await runPage(created.searchId, ctx).catch(
			(error: unknown) => partialPageError(error, rows.length),
		);
		if ("error" in result)
			return {
				rows,
				raw,
				quotaUsed: quotaDelta(quotaStart, quotaEnd, rows.length),
				rejected: false,
				capped: true,
				error: result.error,
			};
		raw.push(result.raw);
		if (result.rejected) {
			return {
				rows,
				raw,
				quotaUsed: rows.length,
				rejected: true,
				capped: rows.length > 0,
			};
		}
		rows = rows.concat(result.page.data.map(toClayRow));
		ledger.metered("clay", "search", result.page.data.length, "records");
		capped = result.page.has_more;
		const used = result.page.period_quota?.used;
		quotaStart ??= used ?? null;
		quotaEnd = used ?? quotaEnd;
		if (!result.page.has_more || result.page.data.length === 0) break;
	}
	return {
		rows,
		raw,
		quotaUsed: quotaDelta(quotaStart, quotaEnd, rows.length),
		rejected: false,
		capped,
	};
}
