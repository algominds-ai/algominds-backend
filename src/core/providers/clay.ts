import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import type { CostLedger } from "@/core/cost";
import { RetryableProviderError } from "@/core/providers/waterfall";

const CLAY_BASE_URL = "https://api.clay.com/public/v0";
const CLAY_MAX_PAGES = 5;
const CLAY_RUN_LIMIT = 500;

const CLAY_BANDS = [
	"founder",
	"owner",
	"board-member",
	"partner",
	"c-suite",
	"vp",
	"director",
	"head",
	"manager",
	"senior",
	"mid-level",
	"entry",
	"intern",
	"unknown",
] as const;

const ClayBandSchema = z.enum(CLAY_BANDS);

export type ClayBand = z.infer<typeof ClayBandSchema>;

export type ClaySearchInput = {
	identifier: string;
	bands?: ClayBand[];
	keywords?: string[];
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
};

type ClayFilters = {
	company_identifier: string[];
	job_title_seniority_levels_v2?: ClayBand[];
	job_title_keywords?: string[];
};

type ClaySearchCreateRequest = {
	source_type: "people";
	filters: ClayFilters;
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
		location: z.string().nullish(),
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

const LINKEDIN_PERSON_URL_PATTERN = /linkedin\.com\/in\/([^/?#]+)/i;

function canonicalPersonUrl(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const match = raw.toLowerCase().match(LINKEDIN_PERSON_URL_PATTERN);
	return match ? `https://linkedin.com/in/${match[1]}` : null;
}

function toClayRow(row: z.infer<typeof ClaySearchRowSchema>): ClayRow {
	return {
		name: row.name ?? null,
		title: row.latest_experience_title ?? null,
		company: row.latest_experience_company ?? null,
		url: canonicalPersonUrl(row.url),
		location: row.location ?? null,
		since: row.latest_experience_start_date ?? null,
	};
}

function buildFilters(input: ClaySearchInput): ClayFilters {
	const filters: ClayFilters = { company_identifier: [input.identifier] };
	if (input.bands) filters.job_title_seniority_levels_v2 = input.bands;
	if (input.keywords) filters.job_title_keywords = input.keywords;
	return filters;
}

async function postClay(
	path: string,
	body: unknown,
	ctx: ClayFetchContext,
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(`${CLAY_BASE_URL}${path}`, {
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
	if (response.status === 429 || response.status >= 500) {
		throw new RetryableProviderError(
			`Clay request to ${path} failed: status ${response.status}`,
		);
	}
	if (!response.ok) {
		throw new NonRetryableError(
			`Clay request to ${path} failed: status ${response.status}`,
		);
	}
	return response.text();
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
		filters: buildFilters(input),
	};
	const text = await postClay("/search/filters-mode", request, ctx);
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

async function runPage(
	searchId: string,
	ctx: ClayFetchContext,
): Promise<{ page: z.infer<typeof ClaySearchRunResponseSchema>; raw: string }> {
	const text = await postClay(
		`/search/filters-mode/${searchId}/run`,
		{ limit: CLAY_RUN_LIMIT },
		ctx,
	);
	const parsed = ClaySearchRunResponseSchema.safeParse(
		parseJson(text, "run response"),
	);
	if (!parsed.success) {
		throw new NonRetryableError(
			"Clay: run response did not match the expected shape",
		);
	}
	return { page: parsed.data, raw: text };
}

function quotaDelta(
	start: number | null,
	end: number | null,
	rows: number,
): number {
	if (start === null || end === null) return rows;
	return Math.max(end - start, rows);
}

/**
 * Runs Clay's two-step people search over `input.identifier`, paging the
 * created search until `has_more` is false or the code-level page ceiling is
 * reached, and returns the mapped rows alongside every untouched reply body.
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
	let quotaEnd: number | null = null;
	for (let page = 0; page < CLAY_MAX_PAGES; page++) {
		const { page: parsedPage, raw: pageRaw } = await runPage(
			created.searchId,
			ctx,
		);
		raw.push(pageRaw);
		rows = rows.concat(parsedPage.data.map(toClayRow));
		const used = parsedPage.period_quota?.used;
		if (used !== undefined) {
			quotaStart = quotaStart ?? used;
			quotaEnd = used;
		}
		if (!parsedPage.has_more) break;
	}
	ledger.metered("clay", "search", rows.length, "records");
	return {
		rows,
		raw,
		quotaUsed: quotaDelta(quotaStart, quotaEnd, rows.length),
	};
}
