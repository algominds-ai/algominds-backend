import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { RetryableProviderError } from "@/core/providers/waterfall";

const JsonValueSchema = z.json();

type Json = z.infer<typeof JsonValueSchema>;

const EXA_CATEGORIES = [
	"company",
	"research paper",
	"news",
	"pdf",
	"github",
	"personal site",
	"people",
	"financial report",
	"linkedin profile",
] as const;

const ExaSearchRequestSchema = z.object({
	query: z.string(),
	numResults: z.number().int().positive().optional(),
	type: z.enum(["neural", "keyword", "auto"]).optional(),
	category: z.enum(EXA_CATEGORIES).optional(),
	startPublishedDate: z.string().optional(),
	startCrawlDate: z.string().optional(),
	includeDomains: z.array(z.string()).optional(),
	excludeDomains: z.array(z.string()).optional(),
	includeText: z.array(z.string()).optional(),
	excludeText: z.array(z.string()).optional(),
	contents: z
		.object({
			text: z.boolean().optional(),
			summary: z.object({ schema: JsonValueSchema.optional() }).optional(),
		})
		.optional(),
});

/** The fields a caller may send to `search`, before defaults are applied. */
export type ExaSearchRequest = z.input<typeof ExaSearchRequestSchema>;

type ValidatedRequest = z.infer<typeof ExaSearchRequestSchema>;

const DATE_FILTER_FIELDS = ["startPublishedDate", "startCrawlDate"] as const;

function rejectCompanyDateFilter(req: ValidatedRequest): void {
	if (req.category !== "company") return;
	const present = DATE_FILTER_FIELDS.filter(
		(field) => req[field] !== undefined,
	);
	if (present.length === 0) return;
	throw new NonRetryableError(
		`Exa: category "company" cannot combine with ${present.join(" or ")}; the company category only supports semantic search without date filters.`,
	);
}

const ExaCostSchema = z
	.object({ total: z.number() })
	.catchall(z.union([z.number(), z.record(z.string(), z.number())]));

type ExaCost = z.infer<typeof ExaCostSchema>;

function flattenCost(rest: Omit<ExaCost, "total">): Record<string, number> {
	const flat: Record<string, number> = {};
	for (const [key, value] of Object.entries(rest)) {
		if (typeof value === "number") {
			flat[key] = value;
			continue;
		}
		for (const [inner, amount] of Object.entries(value)) {
			flat[`${key}.${inner}`] = amount;
		}
	}
	return flat;
}

const ExaResultSchema = z.object({
	url: z.string(),
	title: z.string(),
	publishedDate: z.string().optional(),
	text: z.string().optional(),
	summary: z.string().optional(),
});

const ExaResponseSchema = z.object({
	requestId: z.string(),
	costDollars: ExaCostSchema,
	results: z.array(ExaResultSchema),
});

const ExaErrorSchema = z.object({
	requestId: z.string().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
});

export type ExaResult = {
	url: string;
	title: string;
	publishedDate?: string;
	text?: string;
	summary: Json | null;
};

export type ExaSearchResult = {
	requestId: string;
	results: ExaResult[];
};

function parseSummary(raw: string | undefined): Json | null {
	if (raw === undefined) return null;
	try {
		return JsonValueSchema.parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

function toExaResult(raw: z.infer<typeof ExaResultSchema>): ExaResult {
	return {
		url: raw.url,
		title: raw.title,
		...(raw.publishedDate !== undefined
			? { publishedDate: raw.publishedDate }
			: {}),
		...(raw.text !== undefined ? { text: raw.text } : {}),
		summary: parseSummary(raw.summary),
	};
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return {};
	}
}

function throwForStatus(status: number, body: unknown): never {
	const parsed = ExaErrorSchema.safeParse(body);
	const requestId = parsed.success ? parsed.data.requestId : undefined;
	const reason = parsed.success
		? (parsed.data.message ?? parsed.data.error ?? `status ${status}`)
		: `status ${status}`;
	const detail = requestId
		? `Exa request failed: ${reason} (requestId ${requestId})`
		: `Exa request failed: ${reason}`;
	if (status === 429 || status >= 500) throw new RetryableProviderError(detail);
	throw new NonRetryableError(detail);
}

/**
 * Posts one query to the Exa `/search` endpoint and returns its results with
 * parsed summaries, after reporting the response's cost into `ledger`.
 */
export async function search(
	req: ExaSearchRequest,
	env: Env,
	ledger: CostLedger,
): Promise<ExaSearchResult> {
	const validated = ExaSearchRequestSchema.parse(req);
	rejectCompanyDateFilter(validated);
	const apiKey = await env.EXA_API_KEY.get();
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "x-api-key": apiKey, "content-type": "application/json" },
		body: JSON.stringify(validated),
	});
	const body = await readJson(response);
	if (!response.ok) throwForStatus(response.status, body);
	const parsed = ExaResponseSchema.parse(body);
	const { total, ...rest } = parsed.costDollars;
	ledger.reported("exa", "search", total, flattenCost(rest));
	return {
		requestId: parsed.requestId,
		results: parsed.results.map(toExaResult),
	};
}
