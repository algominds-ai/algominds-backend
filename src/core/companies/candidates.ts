import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import { NOT_A_COMPANY_DOMAIN } from "@/core/companies/gate";
import type { RejectDetail } from "@/core/companies/limits";
import { entityRejectReason, planConstraints } from "@/core/companies/limits";
import { normalizeDomain } from "@/core/db/schema";
import type {
	CompanyEntity,
	ExaResult,
	ExaSearchRequest,
} from "@/core/providers/exa/search";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";

const {
	resultsPerRound: RESULTS_PER_ROUND,
	descriptionChars: DESCRIPTION_CHARS,
} = config.companies;

export type FindCompaniesReject = {
	domain: string | null;
	reason: string;
	stage: "filter" | "gate" | "judge";
	group?: string;
	statuses?: { id: string; status: string }[];
};

/** One page a round retrieved for one company, kept because content read from the web is stored as evidence rather than discarded. */
export type RetrievedPage = { domain: string; url: string; text: string };

export type CompanyMatch = {
	id: string | null;
	url: string;
	title: string;
	signal: string | null;
	quote: string | null;
	publisher: string | null;
	kind: string | null;
	publishedDate: string | null;
	score: number | null;
	evidenceCheck: string | null;
	fitReason: string | null;
};

/**
 * The vendor's own entity object, the fields that describe the match, and
 * which source produced them. `raw` is the vendor's own result for this
 * company, already JSON-stringified: it is stored as evidence unshaped and
 * nothing reads its structure, and pre-serializing it here keeps Exa's
 * recursive `summary` field from reaching every workflow step's own
 * serializability check, which cannot resolve a type that carries it.
 */
export type CompanyCapture = {
	entity: CompanyEntity;
	result: CompanyMatch;
	raw: string;
	source: string;
};

export type CompanyData = {
	provider: string;
	entity: CompanyEntity;
	result: CompanyMatch;
};

export const MAX_EXCLUDED_DOMAINS = 1200;

/**
 * The domains one round tells the vendor not to return: the caller's own list
 * plus every domain already seen. A seen company is rejected by the gate
 * anyway, so naming it up front spends the result slot on a new one instead.
 * Capped at the most Exa accepts.
 */
/** The domains a run excludes before it starts: the caller's list plus the seller's own site, which is never a prospect. */
export function seedExcludedDomains(
	caller: readonly string[],
	seller: IcpDoc["seller"],
): Set<string> {
	const seeded = new Set(caller.map(normalizeDomain));
	if (seller?.domain) seeded.add(normalizeDomain(seller.domain));
	return seeded;
}

export function excludedDomains(
	caller: readonly string[],
	seen: ReadonlySet<string>,
): string[] {
	return [...new Set([...caller, ...seen])]
		.filter((domain) => !NOT_A_COMPANY_DOMAIN.has(domain))
		.slice(0, MAX_EXCLUDED_DOMAINS);
}

/**
 * The Exa request for one round. `query` is the plan's descriptive sentence
 * followed by its numeric bounds and countries as trailing sentences;
 * `excludeDomains` names companies the run already knows, so the vendor
 * never spends a result slot on one.
 */
export function buildSearchRequest(
	plan: SearchPlan,
	excludeDomains: readonly string[] = [],
): ExaSearchRequest {
	const constraints = planConstraints(plan);
	return {
		query: constraints ? `${plan.query} ${constraints}` : plan.query,
		category: "company",
		type: "fast",
		numResults: RESULTS_PER_ROUND,
		...(plan.userLocation ? { userLocation: plan.userLocation } : {}),
		...(excludeDomains.length > 0
			? { excludeDomains: [...excludeDomains] }
			: {}),
	};
}

function describeCompany(entity: CompanyEntity): string {
	const facts: string[] = [];
	if (entity.industry !== null) facts.push(entity.industry);
	if (entity.workforceTotal !== null)
		facts.push(`headcount ${entity.workforceTotal}`);
	if (entity.country !== null)
		facts.push(`${entity.city ? `${entity.city}, ` : ""}${entity.country}`);
	if (entity.foundedYear !== null) facts.push(`founded ${entity.foundedYear}`);
	if (entity.revenueAnnual !== null)
		facts.push(`annual revenue ${entity.revenueAnnual} USD`);
	if (entity.fundingTotal !== null)
		facts.push(`funding raised ${entity.fundingTotal} USD`);
	const description = (entity.description ?? "").slice(0, DESCRIPTION_CHARS);
	return [facts.join("; "), description].filter(Boolean).join(". ");
}

/** The page a row cites: the one that proves the signal when a source gave one, else the company's own site. */
function evidenceUrlOf(result: ExaResult): string {
	return result.evidenceUrl ?? result.url;
}

function toCompanyRow(result: ExaResult, entity: CompanyEntity): CompanyRow {
	return {
		name: entity.name ?? result.title,
		domain: normalizeDomain(result.url),
		linkedinUrl: result.linkedinUrl ?? null,
		evidenceUrl: evidenceUrlOf(result),
		evidenceQuote: result.evidenceQuote ?? null,
		evidencePublisher: result.evidencePublisher ?? null,
		evidenceKind: result.evidenceKind ?? null,
		industry: entity.industry,
		description: describeCompany(entity) || null,
		signal: result.signal ?? null,
		evidenceDate: result.publishedDate ?? null,
	};
}

function toCompanyMatch(result: ExaResult): CompanyMatch {
	return {
		id: result.id,
		url: evidenceUrlOf(result),
		title: result.title,
		signal: result.signal ?? null,
		quote: result.evidenceQuote ?? null,
		publisher: result.evidencePublisher ?? null,
		kind: result.evidenceKind ?? null,
		publishedDate: result.publishedDate ?? null,
		score: result.score ?? null,
		evidenceCheck: null,
		fitReason: null,
	};
}

/** Names the vendor that produced one capture, for the row's `data` column. */
export function toCompanyData(capture: CompanyCapture): CompanyData {
	return {
		provider: capture.source,
		entity: capture.entity,
		result: capture.result,
	};
}

const CompanyDataSchema = z
	.object({
		result: z.object({ id: z.string().nullish() }).nullish(),
		entity: z.object({ workforceTotal: z.number().nullish() }).nullish(),
	})
	.nullish();

/** Reads the Exa organization id a saved company's `data` column captured, or null for a row with no id on record — an agent-sourced company, or one saved before this field existed. */
export function companyExaId(data: unknown): string | null {
	const parsed = CompanyDataSchema.safeParse(data);
	return parsed.success ? (parsed.data?.result?.id ?? null) : null;
}

/** Reads the headcount a saved company's `data` column captured, or null for a row with no headcount on record. */
export function companyWorkforceTotal(data: unknown): number | null {
	const parsed = CompanyDataSchema.safeParse(data);
	return parsed.success ? (parsed.data?.entity?.workforceTotal ?? null) : null;
}

export type FilterOutcome = {
	rows: CompanyRow[];
	rejects: FindCompaniesReject[];
	captures: Record<string, CompanyCapture>;
};

/** Keeps the results whose structured record satisfies the plan's country and headcount limits. A record that states nothing is kept for the judge. */
/**
 * Why a dated page is too old to prove a signal the profile wants fresh. Only
 * arithmetic lives here: a page carrying no date reaches the judge instead,
 * because whether it still proves anything depends on what the page is, and a
 * live job advertisement is current whether or not it prints a date.
 */
function staleRejectReason(
	evidenceDate: string | null,
	recencyDays: number | null,
	today: string,
): string | null {
	if (recencyDays === null || evidenceDate === null) return null;
	const age = Math.round(
		(Date.parse(today) - Date.parse(evidenceDate)) / 86_400_000,
	);
	if (Number.isNaN(age)) return "the evidence date is not a date";
	return age > recencyDays
		? `evidence is ${age} days old, older than the ${recencyDays} the profile allows`
		: null;
}

/** Why one result cannot become a row: its record misses the profile's limits, or its evidence is outside the window. */
function rowRejectReason(
	result: ExaResult,
	entity: CompanyEntity,
	plan: SearchPlan,
	today: string,
): RejectDetail | null {
	const detail = entityRejectReason(entity, plan);
	if (detail) return detail;
	if ((plan.conditionIds?.length ?? 0) > 0) return null;
	const stale = staleRejectReason(
		result.publishedDate ?? null,
		plan.recencyDays,
		today,
	);
	return stale
		? {
				reason: stale,
				group: "evidence outside the window the profile asks for",
			}
		: null;
}

export function filterEntities(
	results: readonly ExaResult[],
	plan: SearchPlan,
	today: string,
): FilterOutcome {
	const outcome: FilterOutcome = {
		rows: [],
		rejects: [],
		captures: {},
	};
	for (const result of results) {
		const entity = result.company;
		if (!entity) {
			outcome.rejects.push({
				domain: normalizeDomain(result.url),
				reason: "no company record in the result",
				stage: "filter",
			});
			continue;
		}
		const detail = rowRejectReason(result, entity, plan, today);
		if (detail) {
			outcome.rejects.push({
				domain: normalizeDomain(result.url),
				reason: detail.reason,
				stage: "filter",
				...(detail.group ? { group: detail.group } : {}),
			});
			continue;
		}
		const row = toCompanyRow(result, entity);
		outcome.rows.push(row);
		if (row.domain) {
			outcome.captures[row.domain] = {
				entity,
				result: toCompanyMatch(result),
				raw: JSON.stringify(result),
				source: plan.source,
			};
		}
	}
	return outcome;
}

/**
 * Collapses rejects that share a numeric group into one counted line, for
 * example `47 companies had a headcount below the floor of 20`. A reject
 * with no group keeps its own reason, deduplicated as before.
 */
export function groupRejectReasons(
	rejects: readonly FindCompaniesReject[],
): string[] {
	const counts = new Map<string, number>();
	const ungrouped = new Set<string>();
	for (const reject of rejects) {
		if (reject.group)
			counts.set(reject.group, (counts.get(reject.group) ?? 0) + 1);
		else ungrouped.add(reject.reason);
	}
	const grouped = Array.from(
		counts,
		([group, count]) =>
			`${count} ${count === 1 ? "company" : "companies"} had a ${group}`,
	);
	return [...grouped, ...ungrouped];
}
