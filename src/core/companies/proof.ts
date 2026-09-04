import { z } from "zod";
import { config } from "@/config";
import type {
	CompanyCapture,
	FindCompaniesReject,
	RetrievedPage,
} from "@/core/companies/candidates";
import type { CompanyRow, Reject, RejectReason } from "@/core/companies/gate";
import type { Verdict } from "@/core/companies/judge";
import type { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type {
	ExaContentsResult,
	QuoteCheckReason,
} from "@/core/providers/exa/contents";
import { exaContents, quoteFoundInText } from "@/core/providers/exa/contents";
import {
	EXA_FETCH_TIMEOUT_MS,
	readJson,
	throwForStatus,
} from "@/core/providers/exa/http";
import type { Requirement } from "@/core/requirements";
import type { SearchPlan } from "@/core/synthesize";

const {
	provingResults: PROVING_RESULTS,
	provingConcurrency: PROVING_CONCURRENCY,
	contentsMaxCharacters: CONTENTS_MAX_CHARACTERS,
	resultsPerRound: MAX_CONTENTS_PAGES,
} = config.companies;

const ProvingResultSchema = z.object({
	url: z.string(),
	title: z.string().nullish(),
	publishedDate: z.string().nullish(),
	text: z.string().nullish(),
	highlights: z.array(z.string()).nullish(),
});

const ProvingResponseSchema = z.object({
	requestId: z.string(),
	costDollars: z.object({ total: z.number() }),
	results: z.array(ProvingResultSchema),
});

/** One page cited for one company, with the sentence the vendor drew from it and the page text that sentence came from. */
export type ProvingHit = {
	url: string;
	quote: string;
	publishedDate: string | null;
	text: string;
};

type ProvingRequest = {
	query: string;
	numResults: number;
	type: "fast";
	includeDomains?: string[];
	startPublishedDate?: string;
	contents: {
		text: { maxCharacters: number };
		highlights: { query: string };
	};
};

async function postProvingSearch(
	request: ProvingRequest,
	env: Env,
	ledger: CostLedger,
): Promise<ProvingHit | null> {
	const apiKey = await env.EXA_API_KEY.get();
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "x-api-key": apiKey, "content-type": "application/json" },
		body: JSON.stringify(request),
		signal: AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS),
	});
	const body = await readJson(response);
	if (!response.ok) throwForStatus("Exa proving", response.status, body);
	const parsed = ProvingResponseSchema.safeParse(body);
	if (!parsed.success) return null;
	ledger.reported("exa", "prove", parsed.data.costDollars.total);
	for (const result of parsed.data.results) {
		const quote = result.highlights?.[0];
		if (!quote) continue;
		return {
			url: result.url,
			quote,
			publishedDate: result.publishedDate ?? null,
			text: result.text ?? "",
		};
	}
	return null;
}

export type ProvingDemand = {
	requirement: Requirement;
	notBefore: string | null;
};

const MS_PER_DAY = 86_400_000;

/** The requirement paired with the earliest date a page may carry and still prove it: `today` less its window, or null when it has no window. */
export function provingDemand(
	requirement: Requirement,
	today: string,
): ProvingDemand {
	if (requirement.windowDays === null) return { requirement, notBefore: null };
	const notBefore = new Date(
		new Date(today).getTime() - requirement.windowDays * MS_PER_DAY,
	);
	return { requirement, notBefore: notBefore.toISOString().slice(0, 10) };
}

function provingRequest(
	query: string,
	demand: ProvingDemand,
	domain: string | null,
): ProvingRequest {
	return {
		query,
		numResults: PROVING_RESULTS,
		type: "fast",
		...(domain ? { includeDomains: [domain] } : {}),
		...(demand.notBefore ? { startPublishedDate: demand.notBefore } : {}),
		contents: {
			text: { maxCharacters: CONTENTS_MAX_CHARACTERS },
			highlights: { query: demand.requirement.text },
		},
	};
}

/**
 * One company's cheapest lookup for the page proving one requirement: a
 * search restricted to the company's own domain, then, only when that finds
 * nothing, one open search naming the company. Resolves null when neither
 * returns a page carrying a sentence about the requirement.
 */
async function proveRequirement(
	row: CompanyRow,
	demand: ProvingDemand,
	env: Env,
	ledger: CostLedger,
): Promise<ProvingHit | null> {
	const name = row.name ?? row.domain ?? "";
	const domain = row.domain === null ? null : normalizeDomain(row.domain);
	if (domain === null) return null;
	const text = demand.requirement.text;
	const scoped = await postProvingSearch(
		provingRequest(`${name}: ${text}`, demand, domain),
		env,
		ledger,
	);
	if (scoped) return scoped;
	return postProvingSearch(
		provingRequest(`${name} (${domain}): ${text}`, demand, null),
		env,
		ledger,
	);
}

export type ProvenRow = { index: number; hit: ProvingHit | null };

/**
 * Runs the proving lookup for every candidate, `provingConcurrency` at a time
 * so a round stays inside Exa's ten-requests-a-second limit. A row whose
 * lookup finds nothing comes back with a null hit and stays unproven.
 */
export async function proveRows(
	rows: readonly CompanyRow[],
	demand: ProvingDemand,
	env: Env,
	ledger: CostLedger,
): Promise<ProvenRow[]> {
	const proven: ProvenRow[] = [];
	for (let at = 0; at < rows.length; at += PROVING_CONCURRENCY) {
		const slice = rows.slice(at, at + PROVING_CONCURRENCY);
		const hits = await Promise.all(
			slice.map(async (row, offset) => ({
				index: at + offset,
				hit: await proveRequirement(row, demand, env, ledger),
			})),
		);
		proven.push(...hits);
	}
	return proven;
}

/** One proved row with its page attached as the evidence the judge reads, so proof reaches the judge in the same shape an agent round produces. */
export function withEvidence(
	row: CompanyRow,
	hit: ProvingHit,
	requirement: Requirement,
): CompanyRow {
	return {
		...row,
		evidenceUrl: hit.url,
		evidenceQuote: hit.quote,
		evidenceDate: hit.publishedDate,
		signal: requirement.text,
	};
}

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
	pages: RetrievedPage[];
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

/** Splits a deduplicated url list into groups of `CONTENTS_BATCH_SIZE`, bounded to `MAX_CONTENTS_PAGES` pages a round ever pays to crawl. */
function contentsBatches(urls: readonly string[]): string[][] {
	const bounded = urls.slice(0, MAX_CONTENTS_PAGES);
	const batches: string[][] = [];
	for (let at = 0; at < bounded.length; at += PROVING_CONCURRENCY) {
		batches.push(bounded.slice(at, at + PROVING_CONCURRENCY));
	}
	return batches;
}

/** Every url's crawl outcome, fetched as concurrent `exaContents` calls of at most `PROVING_CONCURRENCY` urls each rather than one unbounded call. */
async function fetchContents(
	urls: readonly string[],
	env: Env,
	ledger: CostLedger,
): Promise<ExaContentsResult> {
	const batches = await Promise.all(
		contentsBatches(urls).map((batch) => exaContents(batch, env, ledger)),
	);
	return {
		requestId: batches[0]?.requestId ?? "",
		results: batches.flatMap((batch) => batch.results),
		statuses: batches.flatMap((batch) => batch.statuses),
	};
}

/** The page an entry's crawl actually returned, as evidence worth keeping — null when the vendor's reply carries no text for it to store. */
function entryPage(
	row: CompanyRow,
	entry: EvidenceEntry,
	lookup: Map<string, PageOutcome>,
): RetrievedPage | null {
	const text = lookup.get(entry.url)?.text ?? null;
	return row.domain === null || text === null
		? null
		: { domain: row.domain, url: entry.url, text };
}

/**
 * Confirms every gated row's evidence page really exists, for a round whose
 * plan demanded proof from the agent. A row with no quote at all is
 * missing-required. Every row that does carry a quote to check is fetched
 * over the deduplicated url list (two rows can cite one page), in concurrent
 * `exaContents` batches. A row whose page truly does not exist or cannot be
 * fetched at all — `CRAWL_NOT_FOUND` or `UNSUPPORTED_URL` — is
 * evidence-not-on-page; every other outcome (missing, a timeout, a source the
 * crawler was refused) keeps the row, records the check for the judge to
 * see, and keeps the crawled page as evidence when the crawl returned one.
 */
export async function verifyEvidenceRows(
	rows: readonly CompanyRow[],
	env: Env,
	ledger: CostLedger,
): Promise<EvidenceOutcome> {
	const { entries, missing } = collectEvidenceEntries(rows);
	const checks: Record<string, QuoteCheckReason> = {};
	const pages: RetrievedPage[] = [];
	if (entries.length === 0) {
		return { kept: [], rejects: missing, checks, pages };
	}
	const urls = Array.from(new Set(entries.map((entry) => entry.url)));
	const contents = await fetchContents(urls, env, ledger);
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
		const page = entryPage(row, entry, lookup);
		if (page) pages.push(page);
	}
	return { kept, rejects, checks, pages };
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

/** Copies each row's cited page onto its capture, so the stored company names the page that proved it rather than the one the search or agent first returned. */
export function applyRowEvidence(
	captures: Record<string, CompanyCapture>,
	rows: readonly CompanyRow[],
): void {
	for (const row of rows) {
		const capture = row.domain === null ? undefined : captures[row.domain];
		if (!capture || row.evidenceUrl === null) continue;
		capture.result.url = row.evidenceUrl;
		capture.result.quote = row.evidenceQuote;
		capture.result.publisher = row.evidencePublisher;
		capture.result.kind = row.evidenceKind;
		capture.result.publishedDate = row.evidenceDate;
		capture.result.signal = row.signal;
	}
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
		const domain = rows[verdict.index]?.domain;
		const capture = domain ? captures[domain] : undefined;
		if (capture) capture.result.fitReason = verdict.reason;
	}
}

/** Whether the round's plan demanded proof from the agent, the only case an evidence quote was ever asked for. */
export function demandsEvidenceProof(plan: SearchPlan): boolean {
	return plan.source === "exa-agent" && plan.recency !== null;
}
