import { config } from "@/config";
import type { Company } from "@/core/db/schema";
import type { ApolloCandidate } from "@/core/providers/apollo";
import type { ExaResult, ExaSearchRequest } from "@/core/providers/exa";

/** The columns of a saved company this capability actually needs, kept out of Workflow steps' serialization concerns. */
export type PeopleCompany = Pick<Company, "id" | "domain" | "name">;

const RESULTS_PER_COMPANY = config.people.resultsPerCompany;
const MATCHED_CONFIDENCE = 1;
const MISMATCHED_CONFIDENCE = 0.4;
const TITLE_CUT_CHARS = ["@", "(", "|"];

const PERSON_SUMMARY_PROPERTIES: Record<string, { type: "string" }> = {
	fullName: { type: "string" },
	currentTitle: { type: "string" },
	currentCompany: { type: "string" },
	location: { type: "string" },
};

const PERSON_SUMMARY_DESCRIPTION =
	"Extract the person's full name, current job title exactly as written, current employer, and location from this LinkedIn profile.";

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

function personSummarySchema(): {
	type: "object";
	description: string;
	properties: Record<string, { type: "string" }>;
	required: string[];
} {
	return {
		type: "object",
		description: PERSON_SUMMARY_DESCRIPTION,
		properties: PERSON_SUMMARY_PROPERTIES,
		required: ["fullName"],
	};
}

export function buildPersonSearchRequest(
	company: PeopleCompany,
	titles: readonly string[],
): ExaSearchRequest {
	return {
		query: `${titles.join(" OR ")} at ${company.name}`,
		numResults: RESULTS_PER_COMPANY,
		type: "fast",
		category: "linkedin profile",
		contents: { summary: { schema: personSummarySchema() } },
	};
}

type SummaryValue = NonNullable<ExaResult["summary"]>;

function isSummaryObject(
	value: ExaResult["summary"],
): value is { [key: string]: SummaryValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summaryField(
	summary: ExaResult["summary"],
	key: string,
): string | null {
	if (!isSummaryObject(summary)) return null;
	const value = summary[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

type PersonClaim = {
	fullName: string | null;
	rawTitle: string | null;
	currentCompany: string | null;
	location: string | null;
	linkedinUrl: string;
	entity: PersonEntity;
	result: PersonMatch;
};

function toPersonEntity(result: ExaResult): PersonEntity {
	return {
		fullName: summaryField(result.summary, "fullName"),
		currentTitle: summaryField(result.summary, "currentTitle"),
		currentCompany: summaryField(result.summary, "currentCompany"),
		location: summaryField(result.summary, "location"),
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
		currentCompany: entity.currentCompany,
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

function companiesMatch(a: string, b: string): boolean {
	return normalizeCompanyName(a) === normalizeCompanyName(b);
}

function employmentClaims(
	currentCompany: string | null,
	targetName: string,
): EmploymentClaim[] {
	if (currentCompany === null) {
		return [
			{
				company: targetName,
				confidence: MISMATCHED_CONFIDENCE,
				source: "target",
			},
		];
	}
	if (companiesMatch(currentCompany, targetName)) {
		return [
			{
				company: currentCompany,
				confidence: MATCHED_CONFIDENCE,
				source: "exa",
			},
		];
	}
	return [
		{ company: currentCompany, confidence: MATCHED_CONFIDENCE, source: "exa" },
		{
			company: targetName,
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
	const claims = employmentClaims(claim.currentCompany, company.name);
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
