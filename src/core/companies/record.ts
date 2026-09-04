import { config } from "@/config";
import type { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type { CompanyEntity, ExaResult } from "@/core/providers/exa/search";
import { search } from "@/core/providers/exa/search";

const { provingConcurrency: LOOKUP_CONCURRENCY } = config.companies;

const SLICE_WAIT_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One company's own record from Exa's organization index. The reply is kept
 * only when the record it returns is for the domain that was asked for:
 * `includeDomains` on the company category matches a hostname suffix, so a
 * request for `wise.com` also returns `gatewise.com`. The comparison is an
 * identity check on a normalized domain, never a judgement about the company.
 */
export async function lookupRecord(
	domain: string,
	env: Env,
	ledger: CostLedger,
): Promise<ExaResult | null> {
	const wanted = normalizeDomain(domain);
	const found = await search(
		{
			query: wanted,
			category: "company",
			type: "fast",
			numResults: 1,
			includeDomains: [wanted],
		},
		env,
		ledger,
	);
	return (
		found.results.find((result) => normalizeDomain(result.url) === wanted) ??
		null
	);
}

/** The agent's own row for one company, and the vendor record that answers for it. */
export type BackfilledRecord = {
	domain: string;
	record: ExaResult | null;
};

/**
 * Looks up the vendor's own company record for every domain an agent round
 * returned, `provingConcurrency` at a time under Exa's rate limit, waiting
 * one second between slices whenever there is more than one, so the
 * profile's headcount, country and revenue bounds are applied to the vendor's
 * figures rather than to numbers the agent wrote about itself.
 */
export async function backfillRecords(
	domains: readonly string[],
	env: Env,
	ledger: CostLedger,
): Promise<BackfilledRecord[]> {
	const filled: BackfilledRecord[] = [];
	for (let at = 0; at < domains.length; at += LOOKUP_CONCURRENCY) {
		if (at > 0) await sleep(SLICE_WAIT_MS);
		const slice = domains.slice(at, at + LOOKUP_CONCURRENCY);
		const found = await Promise.all(
			slice.map(async (domain) => ({
				domain,
				record: await lookupRecord(domain, env, ledger),
			})),
		);
		filled.push(...found);
	}
	return filled;
}

/**
 * The vendor's record for a company where it has one, falling back to what the
 * agent reported for a company its index has never heard of. A field the
 * vendor left null keeps the agent's own value, since a null is silence.
 */
export function mergeEntity(
	agent: CompanyEntity,
	vendor: CompanyEntity | null,
): CompanyEntity {
	if (vendor === null) return agent;
	return {
		name: vendor.name ?? agent.name,
		description: vendor.description ?? agent.description,
		industry: agent.industry ?? vendor.industry,
		foundedYear: vendor.foundedYear ?? agent.foundedYear,
		workforceTotal: vendor.workforceTotal ?? agent.workforceTotal,
		city: vendor.city ?? agent.city,
		country: vendor.country ?? agent.country,
		revenueAnnual: vendor.revenueAnnual ?? agent.revenueAnnual,
		fundingTotal: vendor.fundingTotal ?? agent.fundingTotal,
	};
}

/** Every agent result with the vendor's own record merged into it, keyed on the normalized domain each lookup was asked for. */
export function applyRecords(
	results: readonly ExaResult[],
	filled: readonly BackfilledRecord[],
): ExaResult[] {
	const byDomain = new Map(
		filled.map((entry) => [entry.domain, entry.record?.company ?? null]),
	);
	return results.map((result) => {
		const agent = result.company;
		if (agent === null) return result;
		const vendor = byDomain.get(normalizeDomain(result.url));
		if (vendor === undefined) return result;
		return { ...result, company: mergeEntity(agent, vendor) };
	});
}
