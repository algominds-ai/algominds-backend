import { config } from "@/config";
import type {
	CompanyCapture,
	FindCompaniesReject,
	RetrievedPage,
} from "@/core/companies/candidates";
import { companyExaId } from "@/core/companies/candidates";
import type { CompanyRow, Reject } from "@/core/companies/gate";
import {
	companyHomepageMatches,
	companyLinkedInFromPage,
	verifiedLinkedInCompanyUrl,
} from "@/core/companies/identity";
import type { Verdict } from "@/core/companies/judge";
import type {
	EvidenceByRow,
	RequirementEvidence,
} from "@/core/companies/judge-evidence";
import type { CostLedger } from "@/core/cost";
import type {
	ExaContentResult,
	ExaContentsOptions,
	ExaContentsResult,
} from "@/core/providers/exa/contents";
import { exaContents } from "@/core/providers/exa/contents";
import { search } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import { conditionRefs, requirementLine } from "@/core/requirements";

const { provingConcurrency: PROVING_CONCURRENCY } = config.companies;

type IdentityPages = {
	pages: readonly ExaContentResult[];
	identityUrls: ReadonlySet<string> | null;
};

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

/** Batches every source for the already bounded candidate rows without starving later companies. */
function contentsBatches(urls: readonly string[], size: number): string[][] {
	const batches: string[][] = [];
	for (let at = 0; at < urls.length; at += size) {
		batches.push(urls.slice(at, at + size));
	}
	return batches;
}

/** Every url's crawl outcome, fetched in bounded batches so the round never launches all provider calls at once. */
async function fetchContents(
	urls: readonly string[],
	env: Env,
	ledger: CostLedger,
	options: ExaContentsOptions = {},
): Promise<ExaContentsResult> {
	const batches: ExaContentsResult[] = [];
	const size = options.byId
		? config.companies.resultsPerRound
		: PROVING_CONCURRENCY;
	for (const batch of contentsBatches(urls, size)) {
		batches.push(await exaContents(batch, env, ledger, options));
	}
	return {
		requestId: batches[0]?.requestId ?? "",
		results: batches.flatMap((batch) => batch.results),
		statuses: batches.flatMap((batch) => batch.statuses),
	};
}

function evidenceQuery(
	requirements: readonly Requirement[],
): string | undefined {
	const conditions = conditionRefs(requirements).map(requirementLine);
	return conditions.length > 0 ? conditions.join("; ") : undefined;
}

export type CompanyEvidenceInput = {
	rows: readonly CompanyRow[];
	captures: Readonly<Record<string, CompanyCapture>>;
	requirements: readonly Requirement[];
};

async function fetchCompanyContents(
	urls: readonly string[],
	env: Env,
	ledger: CostLedger,
	query: string | undefined,
): Promise<ExaContentsResult> {
	const identityUrls = urls.filter((url) => verifiedLinkedInCompanyUrl(url));
	const substantiveUrls = urls.filter((url) => !identityUrls.includes(url));
	const identity = await fetchContents(identityUrls, env, ledger);
	const substantive = await fetchContents(
		substantiveUrls,
		env,
		ledger,
		query
			? { query, maxCharacters: config.companies.contentsMaxCharacters }
			: {},
	);
	return {
		requestId: identity.requestId || substantive.requestId,
		results: [...identity.results, ...substantive.results],
		statuses: [...identity.statuses, ...substantive.statuses],
	};
}

function sourceKey(url: string): string {
	return verifiedLinkedInCompanyUrl(url) ?? url;
}

function fetchedPages(
	contents: ExaContentsResult,
): Map<string, ExaContentsResult["results"][number]> {
	const errors = new Set(
		contents.statuses
			.filter((status) => status.status === "error")
			.map((status) => status.url),
	);
	return new Map(
		contents.results
			.filter(
				(page) =>
					!errors.has(page.id ?? page.url) &&
					!errors.has(page.url) &&
					page.text?.trim(),
			)
			.map((page) => [sourceKey(page.url), page]),
	);
}

/** A fetched company profile must have a valid declared URL and no homepage mismatch. */
function companyProfileMatches(
	page: ExaContentResult | undefined,
	domain: string,
): boolean {
	return Boolean(
		page?.text?.trim() &&
			companyLinkedInFromPage(page.url, page.text) &&
			companyHomepageMatches(page.text, domain),
	);
}

/** Trust only one successfully returned native record with an explicit matching homepage. */
function nativeCompanyIdentity(
	contents: ExaContentsResult,
	id: string | null,
	domain: string,
): IdentityPages | undefined {
	if (!id) return undefined;
	const statuses = contents.statuses.filter((status) => status.url === id);
	if (
		!statuses.some((status) => status.status === "success") ||
		statuses.some((status) => status.status === "error")
	)
		return undefined;
	const pages = contents.results.filter((page) => page.id === id);
	if (pages.length > 1) return { pages, identityUrls: new Set() };
	const page = pages[0];
	return page &&
		companyProfileMatches(page, domain) &&
		/^- Homepage:/m.test(page.text ?? "")
		? { pages: [page], identityUrls: new Set([sourceKey(page.url)]) }
		: undefined;
}

/** Batch missing native IDs before searching; keep each row's identity evidence local. */
async function findMissingLinkedIn(input: {
	rows: readonly CompanyRow[];
	captures: Readonly<Record<string, CompanyCapture>>;
	fetched: ReadonlyMap<string, ExaContentResult>;
	env: Env;
	ledger: CostLedger;
}): Promise<ReadonlyMap<number, IdentityPages>> {
	const { rows, captures, fetched, env, ledger } = input;
	const targets = rows.flatMap((row, index) => {
		const supplied = row.linkedinUrl
			? fetched.get(sourceKey(row.linkedinUrl))
			: undefined;
		if (!row.domain || companyProfileMatches(supplied, row.domain)) return [];
		const id = companyExaId(captures[row.domain]);
		return [
			{
				index,
				name: row.name,
				domain: row.domain,
				id: /^https:\/\/exa\.ai\/library\/organization\/[^/?#\s]+$/.test(
					id ?? "",
				)
					? id
					: null,
			},
		];
	});
	const ids = [
		...new Set(targets.flatMap((target) => (target.id ? [target.id] : []))),
	];
	const native = await fetchContents(ids, env, ledger, {
		byId: true,
		maxCharacters: config.companies.contentsMaxCharacters,
	});
	const byRow = new Map<number, IdentityPages>();
	for (const target of targets) {
		const identity = nativeCompanyIdentity(native, target.id, target.domain);
		if (identity) {
			byRow.set(target.index, identity);
			continue;
		}
		const found = await search(
			{
				query: `${target.name ?? target.domain} official company LinkedIn page ${target.domain}`,
				type: "fast",
				numResults: 3,
				includeDomains: ["linkedin.com/company"],
				contents: {
					text: { maxCharacters: config.companies.contentsMaxCharacters },
				},
			},
			env,
			ledger,
		);
		byRow.set(target.index, {
			pages: found.results
				.filter(
					(result) =>
						result.text?.trim() &&
						companyHomepageMatches(result.text, target.domain),
				)
				.map((page) => ({
					url: page.url,
					text: page.text ?? null,
					publishedDate: page.publishedDate ?? null,
				})),
			identityUrls: null,
		});
	}
	return byRow;
}

function requirementEvidence(
	page: ExaContentResult,
	identityUrls: ReadonlySet<string> | null | undefined,
): RequirementEvidence {
	return {
		url: page.url,
		quote: "",
		text: page.text ?? "",
		publishedDate: page.publishedDate ?? null,
		...(identityUrls &&
			verifiedLinkedInCompanyUrl(page.url) && {
				identityAllowed: identityUrls.has(sourceKey(page.url)),
			}),
	};
}

/** Remove a contradicted supplied identity while retaining separate substantive sources. */
function invalidSuppliedProfile(
	row: CompanyRow,
	page: ExaContentResult,
): boolean {
	return Boolean(
		row.domain &&
			row.linkedinUrl &&
			sourceKey(page.url) === sourceKey(row.linkedinUrl) &&
			!companyProfileMatches(page, row.domain),
	);
}

function evidenceRows(
	rows: readonly CompanyRow[],
	sources: readonly string[][],
	fetched: ReadonlyMap<string, ExaContentsResult["results"][number]>,
	identityByRow: ReadonlyMap<number, IdentityPages>,
): { evidenceByRow: EvidenceByRow; pages: RetrievedPage[] } {
	const evidenceByRow = new Map<number, Map<string, RequirementEvidence>>();
	const pages: RetrievedPage[] = [];
	rows.forEach((row, index) => {
		const evidence = new Map<string, RequirementEvidence>();
		const identity = identityByRow.get(index);
		const rowSources = [
			...(sources[index] ?? []),
			...(identity?.pages.map((page) => page.url) ?? []),
		];
		for (const source of rowSources) {
			const key = sourceKey(source);
			const page =
				identity?.pages.find((entry) => sourceKey(entry.url) === key) ??
				fetched.get(key);
			if (
				!page?.text ||
				!row.domain ||
				evidence.has(page.url) ||
				invalidSuppliedProfile(row, page)
			)
				continue;
			evidence.set(page.url, requirementEvidence(page, identity?.identityUrls));
			pages.push({ domain: row.domain, url: page.url, text: page.text });
		}
		evidenceByRow.set(index, evidence);
	});
	return { evidenceByRow, pages };
}

/** Fetches cited pages once; generated quotes and dates never substitute for retrieved evidence. */
export async function retrieveCompanyEvidence(
	input: CompanyEvidenceInput,
	env: Env,
	ledger: CostLedger,
): Promise<{ evidenceByRow: EvidenceByRow; pages: RetrievedPage[] }> {
	const { rows, captures, requirements } = input;
	const query = evidenceQuery(requirements);
	const sources = rows.map((row) =>
		[
			...(row.domain ? [`https://${row.domain}/`] : []),
			...(captures[row.domain ?? ""]?.evidence ?? []).map(
				(entry) => entry.sourceUrl,
			),
			row.linkedinUrl,
		].filter((url): url is string => url !== null),
	);
	const urls = [...new Set(sources.flat())];
	const contents = await fetchCompanyContents(urls, env, ledger, query);
	const fetched = fetchedPages(contents);
	const identityByRow = await findMissingLinkedIn({
		rows,
		captures,
		fetched,
		env,
		ledger,
	});
	return evidenceRows(rows, sources, fetched, identityByRow);
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
		if (capture) capture.result.qualification = verdict;
	}
}
