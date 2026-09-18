import { config } from "@/config";
import type { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type { ExaResult } from "@/core/providers/exa/search";
import { search } from "@/core/providers/exa/search";

const { provingConcurrency: LOOKUP_CONCURRENCY } = config.companies;

const SLICE_WAIT_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A division's subdomain or product page is not the requested company's own homepage. */
function recordHomepage(result: ExaResult): string | null {
	const url = new URL(result.url);
	const host = url.hostname.replace(/^www\./, "");
	return url.pathname === "/" && host === normalizeDomain(host) ? host : null;
}

/**
 * One company's own record from Exa's organization index. The reply is kept
 * only when the record it returns is for the domain that was asked for:
 * `includeDomains` on the company category matches a hostname suffix, so a
 * request for `wise.com` also returns `gatewise.com`. The comparison is an
 * identity check on a normalized domain, never a judgement about the company.
 */
async function lookupRecord(
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
		found.results.find((result) => recordHomepage(result) === wanted) ?? null
	);
}

/** The agent's own row for one company, and the vendor record that answers for it. */
export type BackfilledRecord = {
	domain: string;
	record: ExaResult | null;
};

/** Fetch one bounded domain batch, then retry only its missing records. */
async function lookupBatch(
	domains: readonly string[],
	env: Env,
	ledger: CostLedger,
): Promise<Map<string, ExaResult | null>> {
	const wanted = new Set(domains.map(normalizeDomain));
	const records = new Map<string, ExaResult | null>();
	if (wanted.size > 1) {
		const found = await search(
			{
				query: `Companies with these websites: ${[...wanted].join(", ")}`,
				category: "company",
				type: "fast",
				numResults: Math.min(wanted.size * 2, config.companies.resultsPerRound),
				includeDomains: [...wanted],
			},
			env,
			ledger,
		);
		for (const result of found.results) {
			const domain = recordHomepage(result);
			if (
				domain &&
				wanted.has(domain) &&
				result.company &&
				!records.has(domain)
			)
				records.set(domain, result);
		}
	}
	const missing = [...wanted].filter((domain) => !records.has(domain));
	for (let offset = 0; offset < missing.length; offset += LOOKUP_CONCURRENCY) {
		if (offset > 0) await sleep(SLICE_WAIT_MS);
		await Promise.all(
			missing.slice(offset, offset + LOOKUP_CONCURRENCY).map(async (domain) => {
				records.set(domain, await lookupRecord(domain, env, ledger));
			}),
		);
	}
	return records;
}

/**
 * Batches native record lookups, retrying missing exact domains individually.
 * Individual fallbacks retain the existing provider concurrency limit.
 */
export async function backfillRecords(
	domains: readonly string[],
	env: Env,
	ledger: CostLedger,
): Promise<BackfilledRecord[]> {
	const filled: BackfilledRecord[] = [];
	const batchSize = config.companies.resultsPerRound;
	for (let at = 0; at < domains.length; at += batchSize) {
		if (at > 0) await sleep(SLICE_WAIT_MS);
		const slice = domains.slice(at, at + batchSize);
		const records = await lookupBatch(slice, env, ledger);
		filled.push(
			...slice.map((domain) => ({
				domain,
				record: records.get(normalizeDomain(domain)) ?? null,
			})),
		);
	}
	return filled;
}

/** Replace an agent result with the exact native provider record when one was found. */
export function applyRecords(
	results: readonly ExaResult[],
	filled: readonly BackfilledRecord[],
): ExaResult[] {
	const byDomain = new Map(
		filled.map((entry) => [normalizeDomain(entry.domain), entry.record]),
	);
	return results.map((result) => {
		const native = byDomain.get(normalizeDomain(result.url));
		if (native === undefined || native === null || native.company === null)
			return result;
		return {
			...result,
			id: native.id,
			company: native.company,
		};
	});
}
