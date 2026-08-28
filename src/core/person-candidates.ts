import { config } from "@/config";
import type { Company } from "@/core/db/schema";
import type { ApolloCandidate } from "@/core/providers/apollo";
import type {
	ExaResult,
	ExaSearchRequest,
	PersonWorkHistoryEntry,
} from "@/core/providers/exa";

/** The columns of a saved company this capability actually needs, kept out of Workflow steps' serialization concerns. `exaId` is the organization id the company category recorded, when one was captured. */
export type PeopleCompany = Pick<Company, "id" | "domain" | "name"> & {
	exaId: string | null;
};

const RESULTS_PER_COMPANY = config.people.resultsPerCompany;
const MATCHED_CONFIDENCE = 1;
const MISMATCHED_CONFIDENCE = 0.4;
const TITLE_CUT_CHARS = ["@", "(", "|"];

export type EmploymentClaim = {
	company: string;
	confidence: number;
	source: "exa" | "target";
};

export type PersonEntity = {
	fullName: string | null;
	currentTitle: string | null;
	currentCompany: string | null;
	location: string | null;
};

export type PersonMatch = {
	url: string;
	title: string;
	publishedDate: string | null;
	score: number | null;
};

export type PersonData = {
	provider: string;
	entity: PersonEntity;
	result: PersonMatch;
};

export type PersonCandidate = {
	fullName: string;
	linkedinUrl: string;
	title: string | null;
	rawTitle: string | null;
	location: string | null;
	employment: EmploymentClaim[];
	employmentConfidence: number;
	apolloMatched: boolean;
	entity: PersonEntity;
	result: PersonMatch;
};

export type ApolloOnlyCandidate = {
	firstName: string;
	lastNameObfuscated: string;
	title: string | null;
	organizationName: string | null;
	hasEmailPath: boolean;
};

export function buildPersonSearchRequest(
	company: PeopleCompany,
	titles: readonly string[],
): ExaSearchRequest {
	return {
		query: `${titles.join(" OR ")} at ${company.name}`,
		numResults: RESULTS_PER_COMPANY,
		type: "fast",
		category: "people",
	};
}

type PersonClaim = {
	fullName: string | null;
	rawTitle: string | null;
	workHistory: PersonWorkHistoryEntry[];
	location: string | null;
	linkedinUrl: string;
	entity: PersonEntity;
	result: PersonMatch;
};

function currentEmployer(
	workHistory: readonly PersonWorkHistoryEntry[],
): PersonWorkHistoryEntry | null {
	return workHistory.find((entry) => entry.current) ?? null;
}

function toPersonEntity(result: ExaResult): PersonEntity {
	const current = currentEmployer(result.person?.workHistory ?? []);
	return {
		fullName: result.person?.fullName ?? null,
		currentTitle: current?.title ?? null,
		currentCompany: current?.companyName ?? null,
		location: result.person?.location ?? null,
	};
}

function toPersonMatch(result: ExaResult): PersonMatch {
	return {
		url: result.url,
		title: result.title,
		publishedDate: result.publishedDate ?? null,
		score: result.score ?? null,
	};
}

export function toPersonClaim(result: ExaResult): PersonClaim {
	const entity = toPersonEntity(result);
	return {
		fullName: entity.fullName,
		rawTitle: entity.currentTitle,
		workHistory: result.person?.workHistory ?? [],
		location: entity.location,
		linkedinUrl: result.url,
		entity,
		result: toPersonMatch(result),
	};
}

/** Wraps one matched person's entity and match info with the vendor that produced them, for the row's `data` column. */
export function toPersonData(
	entity: PersonEntity,
	result: PersonMatch,
	provider: string,
): PersonData {
	return { provider, entity, result };
}

/**
 * Strips a LinkedIn headline down to a comparable job title by cutting at
 * the first `@`, `(`, or `|`, keeping the raw text usable only as evidence.
 */
export function normalizeTitle(raw: string): string {
	const indices = TITLE_CUT_CHARS.map((char) => raw.indexOf(char)).filter(
		(index) => index !== -1,
	);
	const cut = indices.length > 0 ? Math.min(...indices) : raw.length;
	return raw.slice(0, cut).trim();
}

function normalizeCompanyName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * A last-resort name comparison for Apollo, whose free people search returns
 * only an organization name, never the Exa organization id an employment
 * match otherwise settles by.
 */
function companiesMatch(a: string, b: string): boolean {
	return normalizeCompanyName(a) === normalizeCompanyName(b);
}

function matchingCurrentEmployer(
	current: readonly PersonWorkHistoryEntry[],
	exaId: string | null,
): PersonWorkHistoryEntry | null {
	if (exaId === null) return null;
	return current.find((entry) => entry.companyId === exaId) ?? null;
}

function employmentClaims(
	workHistory: readonly PersonWorkHistoryEntry[],
	company: PeopleCompany,
): EmploymentClaim[] {
	const current = workHistory.filter((entry) => entry.current);
	const first = current[0] ?? null;
	if (first === null) {
		return [
			{
				company: company.name,
				confidence: MISMATCHED_CONFIDENCE,
				source: "target",
			},
		];
	}
	const matched = matchingCurrentEmployer(current, company.exaId);
	if (matched !== null) {
		return [
			{
				company: matched.companyName ?? company.name,
				confidence: MATCHED_CONFIDENCE,
				source: "exa",
			},
		];
	}
	return [
		{
			company: first.companyName ?? "unknown employer",
			confidence: MATCHED_CONFIDENCE,
			source: "exa",
		},
		{
			company: company.name,
			confidence: MISMATCHED_CONFIDENCE,
			source: "target",
		},
	];
}

export function toPersonCandidate(
	claim: PersonClaim,
	company: PeopleCompany,
): PersonCandidate | null {
	if (claim.fullName === null) return null;
	const claims = employmentClaims(claim.workHistory, company);
	const target = claims.find((entry) => entry.source === "target");
	return {
		fullName: claim.fullName,
		linkedinUrl: claim.linkedinUrl,
		title: claim.rawTitle !== null ? normalizeTitle(claim.rawTitle) : null,
		rawTitle: claim.rawTitle,
		location: claim.location,
		employment: claims,
		employmentConfidence: target ? target.confidence : MATCHED_CONFIDENCE,
		apolloMatched: false,
		entity: claim.entity,
		result: claim.result,
	};
}

/** Keeps the first company to claim a LinkedIn URL; later claims are dropped. */
export function dedupeAcrossCompanies(
	perCompany: readonly PersonCandidate[][],
): PersonCandidate[][] {
	const seen = new Set<string>();
	return perCompany.map((people) =>
		people.filter((person) => {
			if (seen.has(person.linkedinUrl)) return false;
			seen.add(person.linkedinUrl);
			return true;
		}),
	);
}

function firstToken(value: string): string {
	return value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function apolloMatchesPerson(
	candidate: ApolloCandidate,
	person: PersonCandidate,
	companyName: string,
): boolean {
	const sameFirstName =
		firstToken(candidate.firstName) === firstToken(person.fullName);
	const sameCompany = companiesMatch(
		candidate.organizationName ?? "",
		companyName,
	);
	return sameFirstName && sameCompany;
}

export function toApolloOnlyCandidate(
	candidate: ApolloCandidate,
): ApolloOnlyCandidate {
	return {
		firstName: candidate.firstName,
		lastNameObfuscated: candidate.lastNameObfuscated,
		title: candidate.title,
		organizationName: candidate.organizationName,
		hasEmailPath: false,
	};
}
