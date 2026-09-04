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

function currentRole(
	result: ExaResult,
): { title: string | null; companyName: string } | null {
	const current = result.person?.workHistory.find((entry) => entry.current);
	if (!current?.companyName) return null;
	return { title: current.title, companyName: current.companyName };
}

function matchesCompany(
	employer: string,
	company: ExaPeopleRosterCompany,
): boolean {
	const lower = employer.toLowerCase();
	if (lower.includes(company.domain.toLowerCase())) return true;
	return company.name !== null && lower.includes(company.name.toLowerCase());
}

function toCandidateRow(
	result: ExaResult,
	company: ExaPeopleRosterCompany,
): DedupeRow | null {
	const role = currentRole(result);
	if (!role || !matchesCompany(role.companyName, company)) return null;
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
 * their current employer names its domain or its name, as roster rows, with
 * the raw reply kept whole for evidence. Throws `RetryableProviderError` on
 * 429 and 5xx, `NonRetryableError` on a reply that does not match the
 * expected shape; a miss is an empty row list.
 */
export async function exaPeopleRoster(
	env: Env,
	company: ExaPeopleRosterCompany,
	ledger: CostLedger,
): Promise<ExaPeopleRosterResult> {
	const query = `${SENIOR_TITLES.join(", ")} at "${company.name ?? company.domain}"`;
	const reply = await search(
		{ query, category: "people", type: "fast", numResults: 25 },
		env,
		ledger,
	);
	const rows = reply.results
		.map((result) => toCandidateRow(result, company))
		.filter((row): row is DedupeRow => row !== null);
	return { rows, raw: JSON.stringify(reply) };
}
