import type { CostLedger } from "@/core/cost";
import type { DedupeRow } from "@/core/people/dedupe";
import type { ExaResult } from "@/core/providers/exa/search";
import { search } from "@/core/providers/exa/search";

const SENIOR_TITLES = [
	"founder",
	"CEO",
	"chief",
	"VP",
	"head",
	"director",
] as const;

export type ExaPeopleRosterCompany = {
	domain: string;
	name: string | null;
};

export type ExaPeopleRosterResult = {
	rows: DedupeRow[];
	raw: string;
};

/**
 * The Exa organization id for `domain`, from a one-result company search
 * restricted to it. Null when Exa's company index does not carry the
 * domain. Throws `RetryableProviderError` on 429 and 5xx, `NonRetryableError`
 * on a reply that does not match the expected shape.
 */
export async function exaOrganizationId(
	env: Env,
	domain: string,
	ledger: CostLedger,
): Promise<string | null> {
	const reply = await search(
		{
			query: domain,
			category: "company",
			type: "fast",
			numResults: 1,
			includeDomains: [domain],
		},
		env,
		ledger,
	);
	return reply.results[0]?.id ?? null;
}

function currentRole(result: ExaResult): {
	title: string | null;
	companyId: string | null;
	companyName: string | null;
} | null {
	const current = result.person?.workHistory.find((entry) => entry.current);
	if (!current) return null;
	return {
		title: current.title,
		companyId: current.companyId,
		companyName: current.companyName,
	};
}

function toCandidateRow(
	result: ExaResult,
	organizationId: string,
): DedupeRow | null {
	const role = currentRole(result);
	if (!role || role.companyId !== organizationId) return null;
	return {
		name: result.person?.fullName ?? null,
		title: role.title,
		company: role.companyName,
		url: result.url,
		location: result.person?.location ?? null,
		since: null,
		source: "exa:people",
	};
}

/**
 * Senior people the Exa people index holds for `company`, kept only when
 * their current employer's Exa organization id matches `organizationId`, as
 * roster rows, with the raw reply kept whole for evidence. Throws
 * `RetryableProviderError` on 429 and 5xx, `NonRetryableError` on a reply
 * that does not match the expected shape; a miss is an empty row list.
 */
export async function exaPeopleRoster(
	env: Env,
	company: ExaPeopleRosterCompany,
	organizationId: string,
	ledger: CostLedger,
): Promise<ExaPeopleRosterResult> {
	const query = `${SENIOR_TITLES.join(", ")} at "${company.name ?? company.domain}"`;
	const reply = await search(
		{ query, category: "people", type: "fast", numResults: 25 },
		env,
		ledger,
	);
	const rows = reply.results
		.map((result) => toCandidateRow(result, organizationId))
		.filter((row): row is DedupeRow => row !== null);
	return { rows, raw: JSON.stringify(reply) };
}
