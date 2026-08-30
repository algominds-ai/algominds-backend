import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow, SearchResult } from "@/core/companies/gate";
import { normalizeDomain } from "@/core/db/schema";
import type {
	CompanyEntity,
	ExaResult,
	ExaSearchRequest,
} from "@/core/providers/exa/search";
import { acceptsAdditionalQueries, type SearchPlan } from "@/core/synthesize";

const {
	resultsPerRound: RESULTS_PER_ROUND,
	descriptionChars: DESCRIPTION_CHARS,
} = config.companies;

export type FindCompaniesReject = {
	domain: string | null;
	reason: string;
	stage: "filter" | "gate" | "judge";
	group?: string;
};

export type CompanyMatch = {
	id: string | null;
	url: string;
	title: string;
	signal: string | null;
	quote: string | null;
	publisher: string | null;
	publishedDate: string | null;
	score: number | null;
};

/** The vendor's own entity object, the fields that describe the match, and which source produced them. */
export type CompanyCapture = {
	entity: CompanyEntity;
	result: CompanyMatch;
	source: string;
};

export type CompanyData = {
	provider: string;
	entity: CompanyEntity;
	result: CompanyMatch;
};

const MAX_EXCLUDED_DOMAINS = 1200;

/**
 * The domains one round tells the vendor not to return: the caller's own list
 * plus every domain already seen. A seen company is rejected by the gate
 * anyway, so naming it up front spends the result slot on a new one instead.
 * Capped at the most Exa accepts.
 */
export function excludedDomains(
	caller: readonly string[],
	seen: ReadonlySet<string>,
): string[] {
	return [...new Set([...caller, ...seen])].slice(0, MAX_EXCLUDED_DOMAINS);
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
	const variations = acceptsAdditionalQueries(plan.type)
		? plan.additionalQueries
		: [];
	return {
		query: constraints ? `${plan.query} ${constraints}` : plan.query,
		category: "company",
		type: plan.type,
		numResults: RESULTS_PER_ROUND,
		...(variations.length > 0 ? { additionalQueries: variations } : {}),
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
		industry: entity.industry,
		description: describeCompany(entity) || null,
		signal: result.signal ?? null,
		evidenceDate: result.publishedDate ?? null,
	};
}

function toSearchResult(result: ExaResult): SearchResult {
	return {
		...(result.score !== undefined ? { score: result.score } : {}),
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
		publishedDate: result.publishedDate ?? null,
		score: result.score ?? null,
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

const CompanyDataIdSchema = z
	.object({ result: z.object({ id: z.string().nullish() }).nullish() })
	.nullish();

/** Reads the Exa organization id a saved company's `data` column captured, or null for a row with no id on record — an agent-sourced company, or one saved before this field existed. */
export function companyExaId(data: unknown): string | null {
	const parsed = CompanyDataIdSchema.safeParse(data);
	return parsed.success ? (parsed.data?.result?.id ?? null) : null;
}

export type NumericLimit = {
	label: string;
	reading: (entity: CompanyEntity) => number | null;
	floor: (plan: SearchPlan) => number | null;
	ceiling: (plan: SearchPlan) => number | null;
};

/** Every figure Exa reports for a company that a profile can bound. */
export const NUMERIC_LIMITS: readonly NumericLimit[] = [
	{
		label: "headcount",
		reading: (entity) => entity.workforceTotal,
		floor: (plan) => plan.minWorkforce,
		ceiling: (plan) => plan.maxWorkforce,
	},
	{
		label: "founding year",
		reading: (entity) => entity.foundedYear,
		floor: (plan) => plan.minFoundedYear,
		ceiling: (plan) => plan.maxFoundedYear,
	},
	{
		label: "annual revenue",
		reading: (entity) => entity.revenueAnnual,
		floor: (plan) => plan.minRevenueAnnual,
		ceiling: (plan) => plan.maxRevenueAnnual,
	},
	{
		label: "funding raised",
		reading: (entity) => entity.fundingTotal,
		floor: (plan) => plan.minFundingTotal,
		ceiling: (plan) => plan.maxFundingTotal,
	},
];

function limitRule(limit: NumericLimit, plan: SearchPlan): string | null {
	const floor = limit.floor(plan);
	const ceiling = limit.ceiling(plan);
	if (floor !== null && ceiling !== null) {
		return `Every company must have a ${limit.label} between ${floor} and ${ceiling}.`;
	}
	if (ceiling !== null) {
		return `Every company must have a ${limit.label} of at most ${ceiling}.`;
	}
	if (floor !== null) {
		return `Every company must have a ${limit.label} of at least ${floor}.`;
	}
	return null;
}

/** The plan's bounds and countries as sentences, appended to a query so the vendor's search and any agent both see them stated. */
export function planConstraints(plan: SearchPlan): string {
	const rules = NUMERIC_LIMITS.map((limit) => limitRule(limit, plan)).filter(
		(rule): rule is string => rule !== null,
	);
	if (plan.countries.length > 0) {
		rules.push(
			`Every company must be based in ${plan.countries.join(" or ")}.`,
		);
	}
	return rules.join(" ");
}

type RejectDetail = { reason: string; group?: string };

function numericRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): RejectDetail | null {
	for (const limit of NUMERIC_LIMITS) {
		const reading = limit.reading(entity);
		if (reading === null) continue;
		const ceiling = limit.ceiling(plan);
		if (ceiling !== null && reading > ceiling) {
			const group = `${limit.label} above the limit of ${ceiling}`;
			return {
				reason: `${limit.label} ${reading} above the limit of ${ceiling}`,
				group,
			};
		}
		const floor = limit.floor(plan);
		if (floor !== null && reading < floor) {
			const group = `${limit.label} below the floor of ${floor}`;
			return {
				reason: `${limit.label} ${reading} below the floor of ${floor}`,
				group,
			};
		}
	}
	return null;
}

function countryRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): string | null {
	const { country } = entity;
	if (plan.countries.length === 0 || country === null) return null;
	const allowed = plan.countries.some(
		(name) => name.toLowerCase() === country.toLowerCase(),
	);
	return allowed ? null : `headquarters in ${country}`;
}

function entityRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): RejectDetail | null {
	const countryReason = countryRejectReason(entity, plan);
	if (countryReason !== null) return { reason: countryReason };
	return numericRejectReason(entity, plan);
}

export type FilterOutcome = {
	rows: CompanyRow[];
	results: SearchResult[];
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
export function staleRejectReason(
	evidenceDate: string | null,
	recencyDays: number | null,
	today: string,
): string | null {
	if (recencyDays === null || evidenceDate === null) return null;
	const age = Math.round(
		(Date.parse(today) - Date.parse(evidenceDate)) / 86_400_000,
	);
	if (Number.isNaN(age)) return null;
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
		results: [],
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
		outcome.results.push(toSearchResult(result));
		if (row.domain) {
			outcome.captures[row.domain] = {
				entity,
				result: toCompanyMatch(result),
				source: plan.source,
			};
		}
	}
	return outcome;
}

function rowDomain(row: CompanyRow): string | null {
	return row.domain ? normalizeDomain(row.domain) : null;
}

export function collectDomains(rows: readonly CompanyRow[]): Set<string> {
	const domains = new Set<string>();
	for (const row of rows) {
		const domain = rowDomain(row);
		if (domain) domains.add(domain);
	}
	return domains;
}

export function countUnseen(
	rows: readonly CompanyRow[],
	seen: ReadonlySet<string>,
): number {
	let count = 0;
	for (const row of rows) {
		const domain = rowDomain(row);
		if (domain && !seen.has(domain)) count += 1;
	}
	return count;
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
