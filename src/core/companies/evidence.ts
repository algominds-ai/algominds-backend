import type {
	CompanyCapture,
	FindCompaniesReject,
} from "@/core/companies/candidates";
import type { CompanyRow, Reject, RejectReason } from "@/core/companies/gate";
import type { QuoteCheckReason } from "@/core/providers/page-quote";
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

export type EvidenceReject = {
	index: number;
	reason: RejectReason;
	detail: string | null;
};

export type EvidenceOutcome = {
	kept: CompanyRow[];
	rejects: EvidenceReject[];
	checks: Record<string, QuoteCheckReason>;
};

const PAGE_MISSING_REASONS = new Set<QuoteCheckReason>([
	"fetch:404",
	"fetch:410",
	"fetch:0",
]);

/**
 * Confirms every gated row's evidence page really exists, for a round whose
 * plan demanded proof from the agent. A row with no quote at all is
 * missing-required. A row whose page does not exist — a 404, a 410, or a
 * host that does not resolve — is evidence-not-on-page; every other outcome
 * (missing, a non-2xx status the page still answers, a timeout, an unsafe
 * URL) keeps the row and records the check for the judge to see.
 */
export async function verifyEvidenceRows(
	rows: readonly CompanyRow[],
): Promise<EvidenceOutcome> {
	const kept: CompanyRow[] = [];
	const rejects: EvidenceReject[] = [];
	const checks: Record<string, QuoteCheckReason> = {};
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!row) continue;
		if (row.evidenceUrl === null || row.evidenceQuote === null) {
			rejects.push({ index, reason: "missing-required", detail: null });
			continue;
		}
		const outcome = await quoteOnPage(row.evidenceUrl, row.evidenceQuote);
		if (PAGE_MISSING_REASONS.has(outcome.reason)) {
			rejects.push({
				index,
				reason: "evidence-not-on-page",
				detail: outcome.reason,
			});
			continue;
		}
		kept.push(row);
		if (row.domain) checks[row.domain] = outcome.reason;
	}
	return { kept, rejects, checks };
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

/** Records each kept row's evidence check onto its capture, so the judge and the read routes can see it. */
export function applyEvidenceChecks(
	captures: Record<string, CompanyCapture>,
	checks: Record<string, QuoteCheckReason>,
): void {
	for (const [domain, reason] of Object.entries(checks)) {
		const capture = captures[domain];
		if (capture) capture.result.evidenceCheck = reason;
	}
}

/** Whether the round's plan demanded proof from the agent, the only case an evidence quote was ever asked for. */
export function demandsEvidenceProof(plan: SearchPlan): boolean {
	return plan.source === "exa-agent" && plan.recency !== null;
}
