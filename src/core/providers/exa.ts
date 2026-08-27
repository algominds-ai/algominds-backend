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

const EXA_SEARCH_TYPES = [
	"instant",
	"fast",
	"auto",
	"deep-lite",
	"deep",
	"deep-reasoning",
] as const;

const ExaSearchRequestSchema = z.object({
	query: z.string(),
	numResults: z.number().int().min(1).max(100).optional(),
	type: z.enum(EXA_SEARCH_TYPES).optional(),
	category: z.enum(EXA_CATEGORIES).optional(),
	userLocation: z.string().length(2).optional(),
	startPublishedDate: z.string().optional(),
	endPublishedDate: z.string().optional(),
	includeDomains: z.array(z.string()).max(1200).optional(),
	excludeDomains: z.array(z.string()).max(1200).optional(),
	systemPrompt: z.string().optional(),
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

const ENTITY_INDEX_CATEGORIES = ["company", "people"];

const ENTITY_INDEX_UNSUPPORTED = [
	"startPublishedDate",
	"endPublishedDate",
	"excludeDomains",
] as const;

function rejectEntityIndexFilters(req: ValidatedRequest): void {
	const category = req.category;
	if (category === undefined) return;
	if (!ENTITY_INDEX_CATEGORIES.includes(category)) return;
	const present = ENTITY_INDEX_UNSUPPORTED.filter(
		(field) => req[field] !== undefined,
	);
	if (present.length === 0) return;
	throw new NonRetryableError(
		`Exa: category "${category}" does not support ${present.join(" or ")}; the company and people categories use dedicated indices that only support semantic search.`,
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

const CompanyPropertiesSchema = z.object({
	name: z.string().nullish(),
	description: z.string().nullish(),
	foundedYear: z.number().nullish(),
	workforce: z.object({ total: z.number().nullish() }).nullish(),
	headquarters: z
		.object({ city: z.string().nullish(), country: z.string().nullish() })
		.nullish(),
	financials: z
		.object({
			revenueAnnual: z.number().nullish(),
			fundingTotal: z.number().nullish(),
		})
		.nullish(),
});

const EntitySchema = z.object({
	type: z.string(),
	properties: CompanyPropertiesSchema,
});

const ExaResultSchema = z.object({
	url: z.string(),
	title: z.string(),
	publishedDate: z.string().optional(),
	score: z.number().optional(),
	text: z.string().optional(),
	summary: z.string().optional(),
	entities: z.array(EntitySchema).optional(),
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

/** The structured company record Exa returns for `category: "company"`. Every field can be absent; see `docs/solutions/exa-search-contract.md` for the measured fill rates. */
export type CompanyEntity = {
	name: string | null;
	description: string | null;
	foundedYear: number | null;
	workforceTotal: number | null;
	city: string | null;
	country: string | null;
	revenueAnnual: number | null;
	fundingTotal: number | null;
};

export type ExaResult = {
	url: string;
	title: string;
	publishedDate?: string;
	score?: number;
	text?: string;
	summary: Json | null;
	company: CompanyEntity | null;
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

function toCompanyEntity(
	entities: z.infer<typeof ExaResultSchema>["entities"],
): CompanyEntity | null {
	const found = entities?.find((entity) => entity.type === "company");
	if (!found) return null;
	const p = found.properties;
	return {
		name: p.name ?? null,
		description: p.description ?? null,
		foundedYear: p.foundedYear ?? null,
		workforceTotal: p.workforce?.total ?? null,
		city: p.headquarters?.city ?? null,
		country: p.headquarters?.country ?? null,
		revenueAnnual: p.financials?.revenueAnnual ?? null,
		fundingTotal: p.financials?.fundingTotal ?? null,
	};
}

function toExaResult(raw: z.infer<typeof ExaResultSchema>): ExaResult {
	return {
		company: toCompanyEntity(raw.entities),
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
		? `Exa request failed: ${reason} (requestId ${requestId})`
		: `Exa request failed: ${reason}`;
	if (status === 429 || status >= 500) throw new RetryableProviderError(detail);
	throw new NonRetryableError(detail);
}

function parseResponse(body: unknown): z.infer<typeof ExaResponseSchema> {
	const parsed = ExaResponseSchema.safeParse(body);
	if (parsed.success) return parsed.data;
	const requestId = extractRequestId(body);
	const detail = requestId
		? `Exa: response did not match the expected shape (requestId ${requestId})`
		: "Exa: response did not match the expected shape";
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
	rejectEntityIndexFilters(validated);
	const apiKey = await env.EXA_API_KEY.get();
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "x-api-key": apiKey, "content-type": "application/json" },
		body: JSON.stringify(validated),
	});
	const body = await readJson(response);
	if (!response.ok) throwForStatus(response.status, body);
	const parsed = parseResponse(body);
	const { total, ...rest } = parsed.costDollars;
	ledger.reported("exa", "search", total, flattenCost(rest));
	return {
		requestId: parsed.requestId,
		results: parsed.results.map(toExaResult),
	};
}
