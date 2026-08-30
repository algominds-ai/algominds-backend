import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { RetryableProviderError } from "@/core/providers/waterfall";

const JsonValueSchema = z.json();

type Json = z.infer<typeof JsonValueSchema>;

const ISO_COUNTRY_CODE = /^[A-Z]{2}$/;

const EXA_CATEGORIES = [
	"company",
	"publication",
	"news",
	"personal site",
	"financial report",
	"people",
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
	userLocation: z.string().regex(ISO_COUNTRY_CODE).optional(),
	startPublishedDate: z.string().optional(),
	endPublishedDate: z.string().optional(),
	includeDomains: z.array(z.string()).max(1200).optional(),
	excludeDomains: z.array(z.string()).max(1200).optional(),
	additionalQueries: z.array(z.string()).optional(),
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
type ExaCategory = (typeof EXA_CATEGORIES)[number];

type FilterField = keyof ValidatedRequest;

const UNSUPPORTED_BY_CATEGORY: Partial<
	Record<ExaCategory, readonly FilterField[]>
> = {
	company: ["startPublishedDate", "endPublishedDate"],
	people: ["startPublishedDate", "endPublishedDate", "excludeDomains"],
};

function rejectEntityIndexFilters(req: ValidatedRequest): void {
	const category = req.category;
	if (category === undefined) return;
	const unsupported = UNSUPPORTED_BY_CATEGORY[category];
	if (!unsupported) return;
	const present = unsupported.filter((field) => req[field] !== undefined);
	if (present.length === 0) return;
	throw new NonRetryableError(
		`Exa: category "${category}" does not support ${present.join(" or ")}.`,
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

/** A field that may be absent, null, or present, and is always read as a value or null. */
export const nullableString = z
	.string()
	.nullish()
	.transform((v) => v ?? null);
const nullableNumber = z
	.number()
	.nullish()
	.transform((v) => v ?? null);

/**
 * The company record both Exa endpoints resolve to. The entity index sends it
 * nested and the agent sends it flat, so each has its own parser, but this is
 * the one shape the rest of the code sees.
 */
export const CompanyRecordSchema = z.object({
	name: nullableString,
	description: nullableString,
	foundedYear: nullableNumber,
	workforceTotal: nullableNumber,
	city: nullableString,
	country: nullableString,
	revenueAnnual: nullableNumber,
	fundingTotal: nullableNumber,
});

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

const PersonWorkHistoryCompanySchema = z.object({
	id: z.string().nullish(),
	name: z.string().nullish(),
});

const PersonWorkHistoryEntrySchema = z.object({
	title: z.string().nullish(),
	dates: z
		.object({ from: z.string().nullish(), to: z.string().nullish() })
		.nullish(),
	company: PersonWorkHistoryCompanySchema.nullish(),
});

const PersonPropertiesSchema = z.object({
	name: z.string().nullish(),
	firstName: z.string().nullish(),
	lastName: z.string().nullish(),
	location: z.string().nullish(),
	workHistory: z.array(PersonWorkHistoryEntrySchema).nullish(),
});

const EntitySchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("company"), properties: CompanyPropertiesSchema }),
	z.object({ type: z.literal("person"), properties: PersonPropertiesSchema }),
]);

const ExaResultSchema = z.object({
	id: z.string().optional(),
	url: z.string(),
	title: z.string(),
	publishedDate: z.string().optional(),
	score: z.number().optional(),
	text: z.string().optional(),
	summary: z.string().optional(),
	entities: z.array(z.unknown()).optional(),
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

/** The structured company record Exa returns. Every field can be absent; see `docs/solutions/exa-search-contract.md` for the measured fill rates. */
export type CompanyEntity = z.infer<typeof CompanyRecordSchema>;

/** One employer a person's work history names, as `category: "people"` reports it. `companyId` is the same identifier the `company` category returns for that organization, and is frequently null even for a real employer. `current` is true only when the role carries an explicit null end date. */
export type PersonWorkHistoryEntry = {
	title: string | null;
	from: string | null;
	current: boolean;
	companyId: string | null;
	companyName: string | null;
};

/** The structured person record Exa returns for `category: "people"`, read from the entity whose type is `"person"`. `educationHistory` and `research` are not modelled; nothing reads them. */
export type PersonRecord = {
	fullName: string | null;
	location: string | null;
	workHistory: PersonWorkHistoryEntry[];
};

export type ExaResult = {
	id: string | null;
	url: string;
	title: string;
	publishedDate?: string;
	score?: number;
	text?: string;
	signal?: string;
	evidenceUrl?: string;
	evidenceQuote?: string;
	evidencePublisher?: string;
	linkedinUrl?: string;
	summary: Json | null;
	company: CompanyEntity | null;
	person: PersonRecord | null;
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

type Entity = z.infer<typeof EntitySchema>;
type CompanyMember = Extract<Entity, { type: "company" }>;
type PersonMember = Extract<Entity, { type: "person" }>;

/**
 * Parses each raw entity independently and drops the ones that fail —
 * an unmodelled `type` (or any other shape mismatch) loses that one entity,
 * never the whole result.
 */
function parseEntities(raw: unknown[] | undefined): Entity[] {
	return (raw ?? []).flatMap((candidate) => {
		const parsed = EntitySchema.safeParse(candidate);
		return parsed.success ? [parsed.data] : [];
	});
}

function toCompanyEntity(entities: readonly Entity[]): CompanyEntity | null {
	const found = entities.find(
		(entity): entity is CompanyMember => entity.type === "company",
	);
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

function personFullName(p: PersonMember["properties"]): string | null {
	if (p.name) return p.name;
	const parts = [p.firstName, p.lastName].filter(
		(part): part is string => part !== null && part !== undefined,
	);
	return parts.length > 0 ? parts.join(" ") : null;
}

function toWorkHistoryEntry(
	entry: z.infer<typeof PersonWorkHistoryEntrySchema>,
): PersonWorkHistoryEntry {
	return {
		title: entry.title ?? null,
		from: entry.dates?.from ?? null,
		current: entry.dates?.to === null,
		companyId: entry.company?.id ?? null,
		companyName: entry.company?.name ?? null,
	};
}

function toPersonRecord(entities: readonly Entity[]): PersonRecord | null {
	const found = entities.find(
		(entity): entity is PersonMember => entity.type === "person",
	);
	if (!found) return null;
	const p = found.properties;
	return {
		fullName: personFullName(p),
		location: p.location ?? null,
		workHistory: (p.workHistory ?? []).map(toWorkHistoryEntry),
	};
}

function toExaResult(raw: z.infer<typeof ExaResultSchema>): ExaResult {
	const entities = parseEntities(raw.entities);
	return {
		id: raw.id ?? null,
		company: toCompanyEntity(entities),
		person: toPersonRecord(entities),
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
