import type {
	CompanyCapture,
	FindCompaniesReject,
} from "@/core/companies/candidates";
import type { CompanyRow, Reject, RejectReason } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import type { CostLedger } from "@/core/cost";
import type {
	ExaContentsResult,
	QuoteCheckReason,
} from "@/core/providers/exa/contents";
import { exaContents, quoteFoundInText } from "@/core/providers/exa/contents";
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
	"CRAWL_NOT_FOUND",
	"UNSUPPORTED_URL",
]);

type EvidenceEntry = { index: number; url: string; quote: string };

/** Splits gated rows into the ones with both an evidence url and quote to check, and an immediate missing-required reject for every row missing either. */
function collectEvidenceEntries(rows: readonly CompanyRow[]): {
	entries: EvidenceEntry[];
	missing: EvidenceReject[];
} {
	const entries: EvidenceEntry[] = [];
	const missing: EvidenceReject[] = [];
	rows.forEach((row, index) => {
		if (row.evidenceUrl === null || row.evidenceQuote === null) {
			missing.push({ index, reason: "missing-required", detail: null });
			return;
		}
		entries.push({ index, url: row.evidenceUrl, quote: row.evidenceQuote });
	});
	return { entries, missing };
}

type PageOutcome = { text: string | null; errorTag: string | null };

/** One url's crawl outcome from a batched `exaContents` reply, keyed by url. A url the reply never mentions is not registered, and reads as absent. */
function buildPageLookup(
	contents: ExaContentsResult,
): Map<string, PageOutcome> {
	const lookup = new Map<string, PageOutcome>();
	for (const status of contents.statuses) {
		if (status.status === "error") {
			lookup.set(status.url, {
				text: null,
				errorTag: status.tag ?? "CRAWL_UNKNOWN_ERROR",
			});
		}
	}
	for (const result of contents.results) {
		if (!lookup.has(result.url)) {
			lookup.set(result.url, { text: result.text, errorTag: null });
		}
	}
	return lookup;
}

/** One entry's quote-check outcome. A url the vendor's reply never mentioned is an error, never a found. */
function entryOutcome(
	lookup: Map<string, PageOutcome>,
	entry: EvidenceEntry,
): { found: boolean; reason: QuoteCheckReason } {
	const page = lookup.get(entry.url);
	if (!page) return { found: false, reason: "CRAWL_ABSENT_FROM_REPLY" };
	if (page.errorTag) return { found: false, reason: page.errorTag };
	const found = quoteFoundInText(page.text ?? "", entry.quote);
	return { found, reason: found ? "found" : "missing" };
}

/**
 * Confirms every gated row's evidence page really exists, for a round whose
 * plan demanded proof from the agent. A row with no quote at all is
 * missing-required. Every row that does carry a quote to check is fetched in
 * one batched `exaContents` call, over the deduplicated url list (two rows
 * can cite one page). A row whose page truly does not exist or cannot be
 * fetched at all — `CRAWL_NOT_FOUND` or `UNSUPPORTED_URL` — is
 * evidence-not-on-page; every other outcome (missing, a timeout, a source the
 * crawler was refused) keeps the row and records the check for the judge to
 * see.
 */
export async function verifyEvidenceRows(
	rows: readonly CompanyRow[],
	env: Env,
	ledger: CostLedger,
): Promise<EvidenceOutcome> {
	const { entries, missing } = collectEvidenceEntries(rows);
	const checks: Record<string, QuoteCheckReason> = {};
	if (entries.length === 0) return { kept: [], rejects: missing, checks };
	const urls = Array.from(new Set(entries.map((entry) => entry.url)));
	const contents = await exaContents(urls, env, ledger);
	const lookup = buildPageLookup(contents);
	const kept: CompanyRow[] = [];
	const rejects: EvidenceReject[] = [...missing];
	for (const entry of entries) {
		const row = rows[entry.index];
		if (!row) continue;
		const outcome = entryOutcome(lookup, entry);
		if (PAGE_MISSING_REASONS.has(outcome.reason)) {
			rejects.push({
				index: entry.index,
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

/** Records every kept row's judge reason onto its capture, keyed by the row list `verdicts` indexes into, so the stored company and the read routes can see why it survived. */
export function applyJudgeReasons(
	captures: Record<string, CompanyCapture>,
	rows: readonly CompanyRow[],
	verdicts: readonly Verdict[],
): void {
	for (const verdict of verdicts) {
		if (!verdict.keep) continue;
		const domain = rows[verdict.index]?.domain;
		const capture = domain ? captures[domain] : undefined;
		if (capture) capture.result.fitReason = verdict.reason;
	}
}

/** Whether the round's plan demanded proof from the agent, the only case an evidence quote was ever asked for. */
export function demandsEvidenceProof(plan: SearchPlan): boolean {
	return plan.source === "exa-agent" && plan.recency !== null;
}
