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
} from "@/core/person-candidates";
import {
	apolloMatchesPerson,
	buildPersonSearchRequest,
	dedupeAcrossCompanies,
	normalizeTitle,
	toApolloOnlyCandidate,
	toPersonCandidate,
	toPersonClaim,
	toPersonData,
} from "@/core/person-candidates";
import type {
	ApolloCandidate,
	ApolloSearchFilters,
	ApolloSearchResult,
} from "@/core/providers/apollo";
import type { ExaSearchRequest, ExaSearchResult } from "@/core/providers/exa";
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
].join(" ");

const TitlesModelSchema = z.object({ titles: z.array(z.string()).min(1) });

const DEFAULT_TITLES = [
	"VP of Sales",
	"Head of Growth",
	"Director of Marketing",
];

export type TitlesResult = { titles: string[]; ledger: CostLedger };

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
