import { z } from "zod";
import { CostLedger } from "@/core/cost";
import type { Company } from "@/core/db/schema";
import { generateStructured, workerModel } from "@/core/model";
import type {
	ApolloCandidate,
	ApolloSearchFilters,
	ApolloSearchResult,
} from "@/core/providers/apollo";
import type {
	ExaResult,
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa";
import type { IcpDoc } from "@/core/synthesize";

/** The columns of a saved company this capability actually needs, kept out of Workflow steps' serialization concerns. */
export type PeopleCompany = Pick<Company, "id" | "domain" | "name">;

export const DEFAULT_MAX_COMPANIES = 100;

const RESULTS_PER_COMPANY = 3;
const MATCHED_CONFIDENCE = 1;
const MISMATCHED_CONFIDENCE = 0.4;
const NO_PEOPLE_REASON = "no people found for this company";
const TITLE_CUT_CHARS = ["@", "(", "|"];

const PERSON_SUMMARY_PROPERTIES: Record<string, { type: "string" }> = {
	fullName: { type: "string" },
	currentTitle: { type: "string" },
	currentCompany: { type: "string" },
	location: { type: "string" },
};

const PERSON_SUMMARY_DESCRIPTION =
	"Extract the person's full name, current job title exactly as written, current employer, and location from this LinkedIn profile.";

const TITLES_INSTRUCTIONS = [
	"You choose the job titles a sales team should target for outbound at companies matching",
	"one ideal customer profile. Return three to six decision-maker titles, most senior first,",
	"for the function that would buy or champion this product.",
].join(" ");

const TitlesModelSchema = z.object({ titles: z.array(z.string()).min(1) });

const DEFAULT_TITLES = [
	"VP of Sales",
	"Head of Growth",
	"Director of Marketing",
];

export type TitlesResult = { titles: string[]; ledger: CostLedger };

export type EmploymentClaim = {
	company: string;
	confidence: number;
	source: "exa" | "target";
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
};

export type ApolloOnlyCandidate = {
	firstName: string;
	lastNameObfuscated: string;
	title: string | null;
	organizationName: string | null;
	hasEmailPath: boolean;
};

export type CompanyPeopleResult = {
	domain: string;
	people: PersonCandidate[];
	apolloOnly: ApolloOnlyCandidate[];
	reason: string | null;
};

export type FindPeopleOptions = {
	icp: IcpDoc;
	env: Env;
	maxCompanies?: number;
};

export type FindPeopleDeps = {
	decisionMakerTitles: (icp: IcpDoc, env: Env) => Promise<TitlesResult>;
	search: (
		req: ExaSearchRequest,
		env: Env,
		ledger: CostLedger,
	) => Promise<ExaSearchResult>;
	apolloSearch: (
		filters: ApolloSearchFilters,
		env: Env,
	) => Promise<ApolloSearchResult | null>;
};

export type FindPeopleResult = {
	companies: CompanyPeopleResult[];
	searched: number;
	skippedCompanies: number;
	costDollars: number;
};

function titlesPrompt(icp: IcpDoc): string {
	return [`Ideal customer profile:`, icp.description].join("\n");
}

/**
 * Turns an ICP document into the decision-maker titles a people search
 * targets, falling back to a generic list when the model produces nothing.
 */
export async function decisionMakerTitles(
	icp: IcpDoc,
	env: Env,
): Promise<TitlesResult> {
	const ledger = new CostLedger();
	const output = await generateStructured(
		{
			model: await workerModel(env),
			configuredId: env.MODEL_ROUTE_WORKER,
			instructions: TITLES_INSTRUCTIONS,
			prompt: titlesPrompt(icp),
			schema: TitlesModelSchema,
			headers: { "cf-aig-skip-cache": "true" },
		},
		ledger,
		"decision-maker-titles",
	);
	return { titles: output?.titles ?? DEFAULT_TITLES, ledger };
}

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

function buildPersonSearchRequest(
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
};

function toPersonClaim(result: ExaResult): PersonClaim {
	return {
		fullName: summaryField(result.summary, "fullName"),
		rawTitle: summaryField(result.summary, "currentTitle"),
		currentCompany: summaryField(result.summary, "currentCompany"),
		location: summaryField(result.summary, "location"),
		linkedinUrl: result.url,
	};
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

function toPersonCandidate(
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
	};
}

/** Splits `companies` into the first `max` and how many were left behind. */
export function truncateCompanies(
	companies: readonly PeopleCompany[],
	max: number,
): { companies: PeopleCompany[]; skipped: number } {
	const limited = companies.slice(0, max);
	return { companies: limited, skipped: Math.max(0, companies.length - max) };
}

type PeopleContext = { env: Env; ledger: CostLedger; deps: FindPeopleDeps };

async function searchCompanyPeople(
	company: PeopleCompany,
	titles: readonly string[],
	ctx: PeopleContext,
): Promise<PersonCandidate[]> {
	const request = buildPersonSearchRequest(company, titles);
	const searched = await ctx.deps.search(request, ctx.env, ctx.ledger);
	return searched.results
		.map(toPersonClaim)
		.map((claim) => toPersonCandidate(claim, company))
		.filter((candidate): candidate is PersonCandidate => candidate !== null);
}

/** Keeps the first company to claim a LinkedIn URL; later claims are dropped. */
function dedupeAcrossCompanies(
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

function apolloMatchesPerson(
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

function toApolloOnlyCandidate(
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

async function apolloCoverage(
	company: PeopleCompany,
	titles: readonly string[],
	people: readonly PersonCandidate[],
	ctx: PeopleContext,
): Promise<{ people: PersonCandidate[]; apolloOnly: ApolloCandidate[] }> {
	const filters: ApolloSearchFilters = {
		q_organization_domains_list: [company.domain],
		person_titles: [...titles],
	};
	const result = await ctx.deps.apolloSearch(filters, ctx.env);
	if (!result) return { people: [...people], apolloOnly: [] };
	const marked = people.map((person) =>
		result.candidates.some((candidate) =>
			apolloMatchesPerson(candidate, person, company.name),
		)
			? { ...person, apolloMatched: true }
			: person,
	);
	const apolloOnly = result.candidates.filter(
		(candidate) =>
			!people.some((person) =>
				apolloMatchesPerson(candidate, person, company.name),
			),
	);
	return { people: marked, apolloOnly };
}

async function buildCompanyResult(
	company: PeopleCompany,
	titles: readonly string[],
	people: readonly PersonCandidate[],
	ctx: PeopleContext,
): Promise<CompanyPeopleResult> {
	const coverage = await apolloCoverage(company, titles, people, ctx);
	return {
		domain: company.domain,
		people: coverage.people,
		apolloOnly: coverage.apolloOnly.map(toApolloOnlyCandidate),
		reason: coverage.people.length === 0 ? NO_PEOPLE_REASON : null,
	};
}

/**
 * Runs one Exa people search per company plus a free Apollo coverage pass,
 * with no agent loop and no second employment lookup. `currentCompany` from
 * the same search call is the employment check.
 */
export async function findPeople(
	companies: readonly PeopleCompany[],
	opts: FindPeopleOptions,
	deps: FindPeopleDeps,
): Promise<FindPeopleResult> {
	const { companies: scoped, skipped } = truncateCompanies(
		companies,
		opts.maxCompanies ?? DEFAULT_MAX_COMPANIES,
	);
	const ledger = new CostLedger();
	const titles = await deps.decisionMakerTitles(opts.icp, opts.env);
	const ctx: PeopleContext = { env: opts.env, ledger, deps };

	const rawPerCompany = await Promise.all(
		scoped.map((company) => searchCompanyPeople(company, titles.titles, ctx)),
	);
	const deduped = dedupeAcrossCompanies(rawPerCompany);

	const results = await Promise.all(
		scoped.map((company, index) =>
			buildCompanyResult(company, titles.titles, deduped[index] ?? [], ctx),
		),
	);

	return {
		companies: results,
		searched: scoped.length,
		skippedCompanies: skipped,
		costDollars: CostLedger.merge(titles.ledger, ledger).total(),
	};
}
