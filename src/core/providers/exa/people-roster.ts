import type { CostLedger } from "@/core/cost";
import { normalizeDomain, publicDomain } from "@/core/db/schema";
import type { DedupeRow } from "@/core/people/dedupe";
import type { ExaResult } from "@/core/providers/exa/search";
import { search } from "@/core/providers/exa/search";

export type ExaOrganizationLookup = {
	organizationId: string | null;
	workforceTotal: number | null;
	name: string | null;
	description: string | null;
};

/** Looks up company context only from the result on the exact requested public domain. */
export async function exaOrganizationId(
	env: Env,
	domain: string,
	ledger: CostLedger,
): Promise<ExaOrganizationLookup> {
	const reply = await search(
		{
			query: domain,
			category: "company",
			type: "fast",
			numResults: 3,
			includeDomains: [domain],
		},
		env,
		ledger,
	);
	const match = reply.results.find(
		(result) => publicDomain(result.url) === normalizeDomain(domain),
	);
	return {
		organizationId: match?.id ?? null,
		workforceTotal: match?.company?.workforceTotal ?? null,
		name: match?.company?.name ?? null,
		description: match?.company?.description ?? null,
	};
}

function toCandidateRow(
	result: ExaResult,
	organizationId: string,
): DedupeRow | null {
	const roles =
		result.person?.workHistory.filter(
			(entry) => entry.current && entry.companyId === organizationId,
		) ?? [];
	if (roles.length === 0) return null;
	return {
		name: result.person?.fullName ?? null,
		title:
			[
				...new Set(roles.flatMap((role) => (role.title ? [role.title] : []))),
			].join("; ") || null,
		company: roles[0]?.companyName ?? null,
		url: result.url,
		location: result.person?.location ?? null,
		since: roles[0]?.from ?? null,
		source: "exa:people",
	};
}

export type ExaPeopleRosterCompany = {
	domain: string;
	name: string | null;
	linkedinUrl: string | null;
};

/** Searches the company roster once, retaining every current role at the exact employer. */
export async function exaPeopleRoster(
	env: Env,
	company: ExaPeopleRosterCompany,
	organizationId: string,
	ledger: CostLedger,
) {
	const reply = await search(
		{
			query: `People currently working at ${company.name ?? company.domain}, ${company.domain}, official company ${company.linkedinUrl ?? company.domain}`,
			category: "people",
			type: "fast",
			numResults: 100,
		},
		env,
		ledger,
	);
	const rows = reply.results
		.map((result) => toCandidateRow(result, organizationId))
		.filter((row): row is DedupeRow => row !== null);
	return {
		rows,
		raw: JSON.stringify(reply),
		resultCount: reply.results.length,
		capped: reply.results.length === 100,
	};
}
