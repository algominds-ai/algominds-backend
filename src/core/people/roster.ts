import type { CostLedger } from "@/core/cost";
import type { Candidate } from "@/core/people/candidate";
import type { DedupeRow } from "@/core/people/dedupe";
import { dedupe } from "@/core/people/dedupe";
import { claySearch } from "@/core/providers/clay";
import type { IcpBuyer } from "@/core/synthesize";

export type SeniorRosterResult = {
	candidates: Candidate[];
	raw: string[];
	quotaUsed: number;
};

type RosterBuyer = Pick<IcpBuyer, "bands" | "keywordBands">;

/**
 * Runs one Clay search per band in `buyer.bands` and one per keyworded band
 * in `buyer.keywordBands`, then unions and dedupes every row returned.
 */
export async function seniorRoster(
	identifier: string,
	buyer: RosterBuyer,
	env: Env,
	ledger: CostLedger,
): Promise<SeniorRosterResult> {
	const raw: string[] = [];
	const rows: DedupeRow[] = [];
	let quotaUsed = 0;

	for (const band of buyer.bands) {
		const result = await claySearch(env, { identifier, bands: [band] }, ledger);
		raw.push(...result.raw);
		quotaUsed += result.quotaUsed;
		for (const row of result.rows)
			rows.push({ ...row, source: `clay:${band}` });
	}

	for (const entry of buyer.keywordBands) {
		const result = await claySearch(
			env,
			{ identifier, bands: [entry.band], keywords: entry.keywords },
			ledger,
		);
		raw.push(...result.raw);
		quotaUsed += result.quotaUsed;
		for (const row of result.rows) {
			rows.push({ ...row, source: `clay:${entry.band}:keywords` });
		}
	}

	return { candidates: dedupe(rows), raw, quotaUsed };
}
