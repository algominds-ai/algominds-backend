import { config } from "@/config";
import type { FindCompaniesReject } from "@/core/companies/candidates";
import type { CompanyRow, Reject, RejectReason } from "@/core/companies/gate";
import { quoteOnPage } from "@/core/providers/page-quote";
import type { SearchPlan } from "@/core/synthesize";

export function toGateRejects(
	rows: readonly CompanyRow[],
	rejects: readonly Reject[],
): FindCompaniesReject[] {
	return rejects.map((reject) => ({
		domain: rows[reject.index]?.domain ?? null,
		reason: reject.reason,
		stage: "gate",
	}));
}

const EVIDENCE_FETCH_TIMEOUT_MS = config.companies.evidenceFetchTimeoutMs;

export type EvidenceReject = {
	index: number;
	reason: RejectReason;
	detail: string | null;
};

export type EvidenceOutcome = { kept: CompanyRow[]; rejects: EvidenceReject[] };

/**
 * Confirms every gated row's evidence quote is really on its evidence page,
 * for a round whose plan demanded proof from the agent. A row with no quote
 * at all is missing-required; a row whose page does not carry the quote is
 * evidence-not-on-page.
 */
export async function verifyEvidenceRows(
	rows: readonly CompanyRow[],
): Promise<EvidenceOutcome> {
	const kept: CompanyRow[] = [];
	const rejects: EvidenceReject[] = [];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!row) continue;
		if (row.evidenceUrl === null || row.evidenceQuote === null) {
			rejects.push({ index, reason: "missing-required", detail: null });
			continue;
		}
		const outcome = await quoteOnPage(
			row.evidenceUrl,
			row.evidenceQuote,
			EVIDENCE_FETCH_TIMEOUT_MS,
		);
		if (outcome.found) kept.push(row);
		else {
			rejects.push({
				index,
				reason: "evidence-not-on-page",
				detail: outcome.reason,
			});
		}
	}
	return { kept, rejects };
}

export function toEvidenceRejects(
	rows: readonly CompanyRow[],
	rejects: readonly EvidenceReject[],
): FindCompaniesReject[] {
	return rejects.map((reject) => ({
		domain: rows[reject.index]?.domain ?? null,
		reason: reject.detail ?? reject.reason,
		stage: "gate",
	}));
}

/** Whether the round's plan demanded proof from the agent, the only case an evidence quote was ever asked for. */
export function demandsEvidenceProof(plan: SearchPlan): boolean {
	return plan.source === "exa-agent" && plan.recency !== null;
}
