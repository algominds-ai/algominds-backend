import { z } from "zod";
import { config } from "@/config";
import { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import { generateStructured, workerModel } from "@/core/model";
import type {
	ApolloOnlyCandidate,
	EmploymentClaim,
	PeopleCompany,
	PersonCandidate,
	PersonData,
	PersonEntity,
	PersonMatch,
} from "@/core/people/candidates";
import {
	apolloMatchesPerson,
	buildPersonSearchRequest,
	dedupeAcrossCompanies,
	normalizeTitle,
	toApolloOnlyCandidate,
	toPersonCandidate,
	toPersonClaim,
	toPersonData,
} from "@/core/people/candidates";
import type {
	ApolloCandidate,
	ApolloSearchFilters,
	ApolloSearchResult,
} from "@/core/providers/apollo/index";
import type {
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa/search";
import type { IcpDoc } from "@/core/synthesize";

export type {
	ApolloOnlyCandidate,
	EmploymentClaim,
	PeopleCompany,
	PersonCandidate,
	PersonData,
	PersonEntity,
	PersonMatch,
};
export { normalizeTitle, toPersonData };

export const DEFAULT_MAX_COMPANIES = 100;

const NO_PEOPLE_REASON = "no people found for this company";

const TITLES_INSTRUCTIONS = [
	"You choose the job titles a sales team should target for outbound at companies matching",
	"one ideal customer profile. Return three to six decision-maker titles, most senior first,",
	"for the function that would buy or champion this product.",
	"The titles are the whole answer: the search itself is built from them and the company name.",
	"userLocation is optional and null is the right answer most of the time.",
	"Set it to a two-letter country only when searching outside that country would return the",
	"wrong people. A good decision maker often sits somewhere the profile never mentions, and a",
	"country filter hides them, so leave it null whenever the search reads fine without it.",
].join(" ");

const TitlesModelSchema = z.object({
	titles: z.array(z.string()).min(1),
	userLocation: z.string().nullable(),
});

const DEFAULT_TITLES = [
	"VP of Sales",
	"Head of Growth",
	"Director of Marketing",
];

const ISO_COUNTRY = /^[A-Za-z]{2}$/;

/** The model's country as Exa takes it, or null when it named none it could support. */
function countryCode(written: string | null | undefined): string | null {
	if (!written || !ISO_COUNTRY.test(written)) return null;
	return written.toUpperCase();
}

export type TitlesResult = {
	titles: string[];
	userLocation: string | null;
	ledger: CostLedger;
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
	plan: PeopleSearchPlan;
	maxCompanies?: number;
};

export type FindPeopleDeps = {
	search: (
		company: PeopleCompany,
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
 * targets and the query that finds them, falling back to a generic list and
 * a generic query when the model produces nothing.
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
	return {
		titles: output?.titles ?? DEFAULT_TITLES,
		userLocation: countryCode(output?.userLocation),
		ledger,
	};
}

/**
 * The number of companies one people run searches: the caller's own request
 * when they give one, else the configured fallback, clamped to the configured
 * ceiling either way.
 */
export function resolveMaxCompanies(requested: number | undefined): number {
	return Math.min(
		requested ?? config.limits.defaultMaxCompaniesPerPeopleRun,
		config.limits.maxCompaniesPerPeopleRun,
	);
}

/** Splits `companies` into the first `max` and how many were left behind. */
export function truncateCompanies(
	companies: readonly PeopleCompany[],
	max: number,
): { companies: PeopleCompany[]; skipped: number } {
	const limited = companies.slice(0, max);
	return { companies: limited, skipped: Math.max(0, companies.length - max) };
}

/**
 * Splits `companies` into those not already in `knownDomains` and the
 * domains of those that are, so a company whose people are already resolved
 * is reported rather than silently dropped.
 */
export function splitKnownCompanies(
	companies: readonly PeopleCompany[],
	knownDomains: ReadonlySet<string>,
): { companies: PeopleCompany[]; skipped: string[] } {
	const unsearched: PeopleCompany[] = [];
	const skipped: string[] = [];
	for (const candidate of companies) {
		if (knownDomains.has(normalizeDomain(candidate.domain))) {
			skipped.push(candidate.domain);
		} else {
			unsearched.push(candidate);
		}
	}
	return { companies: unsearched, skipped };
}

export type PeopleSearchPlan = {
	titles: readonly string[];
	userLocation: string | null;
};

type PeopleContext = {
	env: Env;
	ledger: CostLedger;
	deps: FindPeopleDeps;
	plan: PeopleSearchPlan;
};

async function searchCompanyPeople(
	company: PeopleCompany,
	ctx: PeopleContext,
): Promise<PersonCandidate[]> {
	const request = buildPersonSearchRequest(company, ctx.plan);
	const searched = await ctx.deps.search(company, request, ctx.env, ctx.ledger);
	return searched.results
		.map(toPersonClaim)
		.map((claim) => toPersonCandidate(claim, company))
		.filter((candidate): candidate is PersonCandidate => candidate !== null);
}

/**
 * The people Apollo lists at this company's domain that the search did not
 * return. Apollo's people search is free and is scoped to the domain, so it
 * costs nothing to ask and answers a question the search cannot: who else is
 * there. It reports an obfuscated surname and no LinkedIn URL, so it widens
 * coverage rather than standing in for a person the search found.
 */
async function apolloCoverage(
	company: PeopleCompany,
	titles: readonly string[],
	people: readonly PersonCandidate[],
	ctx: PeopleContext,
): Promise<ApolloCandidate[]> {
	const result = await ctx.deps.apolloSearch(
		{
			q_organization_domains_list: [company.domain],
			person_titles: [...titles],
		},
		ctx.env,
	);
	if (!result) return [];
	return result.candidates.filter(
		(candidate) =>
			!people.some((person) =>
				apolloMatchesPerson(candidate, person, company.name),
			),
	);
}

async function buildCompanyResult(
	company: PeopleCompany,
	titles: readonly string[],
	people: readonly PersonCandidate[],
	ctx: PeopleContext,
): Promise<CompanyPeopleResult> {
	const apolloOnly = await apolloCoverage(company, titles, people, ctx);
	return {
		domain: company.domain,
		people: [...people],
		apolloOnly: apolloOnly.map(toApolloOnlyCandidate),
		reason: people.length === 0 ? NO_PEOPLE_REASON : null,
	};
}

/**
 * Runs one Exa people search per company plus a free Apollo coverage pass,
 * with no agent loop and no second employment lookup. The work history the
 * same search call returns is the employment check. The search plan is resolved
 * once for the run and handed in, because it depends only on the profile.
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
	const ctx: PeopleContext = { env: opts.env, ledger, deps, plan: opts.plan };

	const rawPerCompany = await Promise.all(
		scoped.map((company) => searchCompanyPeople(company, ctx)),
	);
	const deduped = dedupeAcrossCompanies(rawPerCompany);

	const results = await Promise.all(
		scoped.map((company, index) =>
			buildCompanyResult(company, opts.plan.titles, deduped[index] ?? [], ctx),
		),
	);

	return {
		companies: results,
		searched: scoped.length,
		skippedCompanies: skipped,
		costDollars: ledger.total(),
	};
}
