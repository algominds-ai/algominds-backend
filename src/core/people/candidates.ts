import { config } from "@/config";
import type { Company } from "@/core/db/schema";
import type { ApolloCandidate } from "@/core/providers/apollo/index";
import type {
	ExaResult,
	ExaSearchRequest,
	PersonWorkHistoryEntry,
} from "@/core/providers/exa/search";

/** The columns of a saved company this capability actually needs, kept out of Workflow steps' serialization concerns. `exaId` is the organization id the company category recorded, when one was captured. */
export type PeopleCompany = Pick<Company, "id" | "domain" | "name"> & {
	exaId: string | null;
};

const RESULTS_PER_COMPANY = config.people.resultsPerCompany;
const MATCHED_CONFIDENCE = 1;
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
	id: string | null;
	url: string;
	title: string;
	publishedDate: string | null;
	score: number | null;
};

export type PersonData = {
	provider: string;
	entity: PersonEntity;
	result: PersonMatch;
	employment: EmploymentClaim[];
	confidence: number;
};

export type PersonCandidate = {
	fullName: string;
	linkedinUrl: string;
	title: string | null;
	rawTitle: string | null;
	location: string | null;
	employment: EmploymentClaim[];
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

/**
 * The Exa request for one company's decision makers. The company name is
 * quoted, because unquoted it matches people whose own name merely resembles
 * it: a search for Ediphi returned three people called Ed, and none of the
 * twenty five worked there. Quoted, twenty of twenty five did.
 */
export function buildPersonSearchRequest(
	company: PeopleCompany,
	plan: { titles: readonly string[]; userLocation: string | null },
): ExaSearchRequest {
	return {
		query: `${plan.titles.join(", ")} at "${company.name}"`,
		numResults: RESULTS_PER_COMPANY,
		type: "fast",
		category: "people",
		...(plan.userLocation ? { userLocation: plan.userLocation } : {}),
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
		id: result.id ?? null,
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
/**
 * The row's stored record of one person: the vendor's own entity and match,
 * who corroborated the employment, and how sure the engine is that they work
 * at the company the run searched.
 */
export function toPersonData(
	person: Pick<PersonCandidate, "entity" | "result" | "employment">,
	provider: string,
): PersonData {
	return {
		provider,
		entity: person.entity,
		result: person.result,
		employment: person.employment,
		confidence: employmentConfidence(person.employment),
	};
}

/** How sure the engine is of the employment claim it kept, lowest claim wins. */
function employmentConfidence(claims: readonly EmploymentClaim[]): number {
	if (claims.length === 0) return 0;
	return Math.min(...claims.map((claim) => claim.confidence));
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
 * Compares employer names. Apollo's free people search returns no
 * organization id, so it always needs this. An id-based employment match
 * falls back to it too, but only for a work history entry whose own
 * `companyId` is null — a decidable id mismatch is never overridden by a
 * name that happens to agree.
 */
function companiesMatch(a: string, b: string): boolean {
	return normalizeCompanyName(a) === normalizeCompanyName(b);
}

function entryMatchesCompany(
	entry: PersonWorkHistoryEntry,
	company: PeopleCompany,
): boolean {
	if (company.exaId !== null && entry.companyId !== null) {
		return entry.companyId === company.exaId;
	}
	return (
		entry.companyName !== null &&
		companiesMatch(entry.companyName, company.name)
	);
}

/** The one employer a verified person has: the entry whose id is the company's. */
function verifiedEmployment(
	workHistory: readonly PersonWorkHistoryEntry[],
	company: PeopleCompany,
): EmploymentClaim | null {
	const matched = workHistory
		.filter((entry) => entry.current)
		.find((entry) => entryMatchesCompany(entry, company));
	if (!matched) return null;
	return {
		company: matched.companyName ?? company.name,
		confidence: MATCHED_CONFIDENCE,
		source: "exa",
	};
}

/**
 * One searched person, or `null` when the vendor's own work history does not
 * place them at this company. A search for a title at a company name also
 * returns people whose own name resembles it, and every company Exa returns
 * carries an identifier, so employment is decided by that identifier rather
 * than scored against the name that was searched for.
 */
export function toPersonCandidate(
	claim: PersonClaim,
	company: PeopleCompany,
): PersonCandidate | null {
	if (claim.fullName === null) return null;
	const employment = verifiedEmployment(claim.workHistory, company);
	if (employment === null) return null;
	return {
		fullName: claim.fullName,
		linkedinUrl: claim.linkedinUrl,
		title: claim.rawTitle !== null ? normalizeTitle(claim.rawTitle) : null,
		rawTitle: claim.rawTitle,
		location: claim.location,
		employment: [employment],
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
