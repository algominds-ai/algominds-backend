import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow, SearchResult } from "@/core/companies/gate";
import { normalizeDomain } from "@/core/db/schema";
import type {
	CompanyEntity,
	ExaResult,
	ExaSearchRequest,
} from "@/core/providers/exa/search";
import type { SearchPlan } from "@/core/synthesize";

const {
	resultsPerRound: RESULTS_PER_ROUND,
	descriptionChars: DESCRIPTION_CHARS,
} = config.companies;

export type FindCompaniesReject = {
	domain: string | null;
	reason: string;
	stage: "filter" | "gate" | "judge";
};

export type CompanyMatch = {
	id: string | null;
	url: string;
	title: string;
	publishedDate: string | null;
	score: number | null;
};

/** The vendor's own entity object next to the fields that describe the match, kept apart until a provider is known. */
export type CompanyCapture = {
	entity: CompanyEntity;
	result: CompanyMatch;
};

export type CompanyData = {
	provider: string;
	entity: CompanyEntity;
	result: CompanyMatch;
};

export function buildSearchRequest(plan: SearchPlan): ExaSearchRequest {
	return {
		query: plan.query,
		category: "company",
		numResults: RESULTS_PER_ROUND,
		...(plan.userLocation ? { userLocation: plan.userLocation } : {}),
	};
}

function describeCompany(entity: CompanyEntity): string {
	const facts: string[] = [];
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

function toCompanyRow(result: ExaResult, entity: CompanyEntity): CompanyRow {
	return {
		name: entity.name ?? result.title,
		domain: normalizeDomain(result.url),
		linkedinUrl: null,
		evidenceUrl: result.url,
		signal: describeCompany(entity) || null,
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
		url: result.url,
		title: result.title,
		publishedDate: result.publishedDate ?? null,
		score: result.score ?? null,
	};
}

/** Wraps one capture with the vendor that produced it, for the row's `data` column. */
export function toCompanyData(
	capture: CompanyCapture,
	provider: string,
): CompanyData {
	return { provider, entity: capture.entity, result: capture.result };
}

const CompanyDataIdSchema = z
	.object({ result: z.object({ id: z.string().nullish() }).nullish() })
	.nullish();

/** Reads the Exa organization id a saved company's `data` column captured, or null for a row with no id on record — an agent-sourced company, or one saved before this field existed. */
export function companyExaId(data: unknown): string | null {
	const parsed = CompanyDataIdSchema.safeParse(data);
	return parsed.success ? (parsed.data?.result?.id ?? null) : null;
}

function entityRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): string | null {
	const { country } = entity;
	if (plan.countries.length > 0 && country !== null) {
		const allowed = plan.countries.some(
			(name) => name.toLowerCase() === country.toLowerCase(),
		);
		if (!allowed) return `headquarters in ${country}`;
	}
	const staff = entity.workforceTotal;
	if (staff === null) return null;
	if (plan.maxWorkforce !== null && staff > plan.maxWorkforce)
		return `headcount ${staff} above the limit of ${plan.maxWorkforce}`;
	if (plan.minWorkforce !== null && staff < plan.minWorkforce)
		return `headcount ${staff} below the floor of ${plan.minWorkforce}`;
	return null;
}

export type FilterOutcome = {
	rows: CompanyRow[];
	results: SearchResult[];
	rejects: FindCompaniesReject[];
	captures: Record<string, CompanyCapture>;
};

/** Keeps the results whose structured record satisfies the plan's country and headcount limits. A record that states nothing is kept for the judge. */
export function filterEntities(
	results: readonly ExaResult[],
	plan: SearchPlan,
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
		const reason = entityRejectReason(entity, plan);
		if (reason) {
			outcome.rejects.push({
				domain: normalizeDomain(result.url),
				reason,
				stage: "filter",
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
