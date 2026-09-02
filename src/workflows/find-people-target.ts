import { NonRetryableError } from "cloudflare:workflows";
import type { CompanyDomainMatch } from "@/core/db/company-domains";
import { companiesForDomains } from "@/core/db/company-domains";
import { companiesForRun, findRun } from "@/core/db/queries";
import type { Company } from "@/core/db/schema";
import type { FindPeoplePayload } from "@/workflows/find-people";

export type TargetCompany = Pick<
	Company,
	"id" | "domain" | "name" | "linkedinUrl" | "icpId"
>;

export type TargetCompanies = {
	companies: TargetCompany[];
	icpId: string | null;
	unknownDomains: string[];
};

async function targetByRun(
	env: Env,
	runId: string,
	organizationId: string,
): Promise<TargetCompanies> {
	const runRow = await findRun(env, runId);
	if (!runRow || runRow.organizationId !== organizationId) {
		throw new NonRetryableError(`findPeople: unknown run ${runId}`);
	}
	const companies = await companiesForRun(env, runRow);
	return {
		companies: companies.map((row) => ({
			id: row.id,
			domain: row.domain,
			name: row.name,
			linkedinUrl: row.linkedinUrl,
			icpId: row.icpId,
		})),
		icpId: runRow.icpId,
		unknownDomains: [],
	};
}

/**
 * Narrows domain matches to the companies of one profile. A domain can name a
 * company under more than one profile, so the first match picks the profile
 * and every company outside it is reported as unmatched rather than mixed in.
 */
export function companiesOfOneProfile(
	matches: readonly CompanyDomainMatch[],
	domains: readonly string[],
): TargetCompanies {
	const icpId = matches[0]?.icpId;
	if (icpId === undefined) {
		throw new NonRetryableError(
			"findPeople: no known company for the given domains",
		);
	}
	const byDomain = new Map(
		matches
			.filter((row) => row.icpId === icpId)
			.map((row) => [row.domain, row]),
	);
	return {
		companies: [...byDomain.values()].map(
			({ id, domain, name, linkedinUrl }) => ({
				id,
				domain,
				name,
				linkedinUrl,
				icpId,
			}),
		),
		icpId,
		unknownDomains: domains.filter((domain) => !byDomain.has(domain)),
	};
}

/**
 * Resolves a domain list to the companies of one profile. A domain can name a
 * company under more than one profile, so the first match picks the profile
 * and every company outside it is dropped rather than mixed in.
 */
async function targetByDomains(
	env: Env,
	domains: readonly string[],
	organizationId: string,
): Promise<TargetCompanies> {
	const matches = await companiesForDomains(env, domains, organizationId);
	if (matches.length === 0) {
		throw new NonRetryableError(
			`findPeople: no known company for domains ${domains.join(", ")}`,
		);
	}
	return companiesOfOneProfile(matches, domains);
}

/** Resolves the companies a people run searches, from a companies run id or a domain list, scoped to the caller's organization. */
export function loadTargetCompanies(
	env: Env,
	payload: FindPeoplePayload,
): Promise<TargetCompanies> {
	return "runId" in payload
		? targetByRun(env, payload.runId, payload.organizationId)
		: targetByDomains(env, payload.domains, payload.organizationId);
}
