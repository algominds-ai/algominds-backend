import { NonRetryableError } from "cloudflare:workflows";
import type { CompanyDomainMatch } from "@/core/db/company-domains";
import { companiesForDomains } from "@/core/db/company-domains";
import { companiesForRun, findRun, loadIcp } from "@/core/db/queries";
import type { FindPeoplePayload } from "@/workflows/find-people";

export type TargetCompany = {
	id: string | null;
	domain: string;
	name: string | null;
	linkedinUrl: string | null;
	icpId: string | null;
	workforceTotal: number | null;
};

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
			workforceTotal: row.workforceTotal,
		})),
		icpId: runRow.icpId,
		unknownDomains: [],
	};
}

function sharedProfileId(
	matches: readonly CompanyDomainMatch[],
): string | null {
	const first = matches[0]?.icpId ?? null;
	if (first === null) return null;
	return matches.every((row) => row.icpId === first) ? first : null;
}

/**
 * The profile a `domains` request applies: the caller's own `icpId` when
 * given and owned by their organization, else the one profile every matched
 * stored row shares, else none.
 */
async function resolvedProfileId(
	env: Env,
	organizationId: string,
	requestedIcpId: string | undefined,
	matches: readonly CompanyDomainMatch[],
): Promise<string | null> {
	if (requestedIcpId === undefined) return sharedProfileId(matches);
	const icpRow = await loadIcp(env, requestedIcpId);
	if (!icpRow || icpRow.organizationId !== organizationId) {
		throw new NonRetryableError(
			`findPeople: icp ${requestedIcpId} does not belong to organization ${organizationId}`,
		);
	}
	return requestedIcpId;
}

function toTargetCompany(
	domain: string,
	row: CompanyDomainMatch | undefined,
	profileId: string | null,
): TargetCompany {
	if (!row) {
		return {
			id: null,
			domain,
			name: null,
			linkedinUrl: null,
			icpId: profileId,
			workforceTotal: null,
		};
	}
	return {
		id: row.id,
		domain: row.domain,
		name: row.name,
		linkedinUrl: row.linkedinUrl,
		icpId: profileId,
		workforceTotal: row.workforceTotal,
	};
}

async function targetByDomains(
	env: Env,
	domains: readonly string[],
	organizationId: string,
	requestedIcpId: string | undefined,
): Promise<TargetCompanies> {
	const matches = await companiesForDomains(env, domains, organizationId);
	const profileId = await resolvedProfileId(
		env,
		organizationId,
		requestedIcpId,
		matches,
	);
	const usable = new Map(
		matches
			.filter((row) => row.icpId === profileId)
			.map((row) => [row.domain, row]),
	);
	return {
		companies: domains.map((domain) =>
			toTargetCompany(domain, usable.get(domain), profileId),
		),
		icpId: profileId,
		unknownDomains: [],
	};
}

/** Resolves the companies a people run searches, from a companies run id or a domain list, scoped to the caller's organization. */
export function loadTargetCompanies(
	env: Env,
	payload: FindPeoplePayload,
): Promise<TargetCompanies> {
	return "runId" in payload
		? targetByRun(env, payload.runId, payload.organizationId)
		: targetByDomains(
				env,
				payload.domains,
				payload.organizationId,
				payload.icpId,
			);
}
