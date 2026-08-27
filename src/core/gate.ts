import { normalizeDomain } from "@/core/db/schema";

export type Citation = {
	url: string;
	title?: string;
};

export type Confidence = "low" | "medium" | "high";

export type GroundingEntry = {
	field: string;
	citations: Citation[];
	confidence?: Confidence | null;
};

const FIELD_NAMES = [
	"name",
	"domain",
	"linkedinUrl",
	"evidenceUrl",
	"signal",
	"evidenceDate",
] as const;

export type CompanyField = (typeof FIELD_NAMES)[number];

export type CompanyRow = { [K in CompanyField]: string | null };

const REQUIRED_FIELDS: readonly CompanyField[] = [
	"name",
	"domain",
	"evidenceUrl",
];

export type RejectReason =
	| "missing-required"
	| "echoes-query"
	| "ungrounded"
	| "low-confidence"
	| "stale-evidence"
	| "bad-date"
	| "already-seen";

export type Reject = {
	index: number;
	reason: RejectReason;
};

export type GateOptions = {
	freshnessDays: number;
	seenDomains: ReadonlySet<string>;
	confidenceFloor?: Confidence;
	query?: string;
};

export type GateResult = {
	kept: CompanyRow[];
	rejects: Reject[];
};

export type RowGrounding = {
	citations: Citation[];
	confidence: Confidence | null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROW_INDEX = /^structured\.companies\[(\d+)\]/;
const CONFIDENCE_RANK: { low: number; medium: number; high: number } = {
	low: 0,
	medium: 1,
	high: 2,
};

function parseRowIndex(field: string): number | null {
	const raw = ROW_INDEX.exec(field)?.[1];
	return raw === undefined ? null : Number(raw);
}

/** Maps each grounded row index to its merged citations and latest confidence, ignoring any trailing field suffix such as `.sourceUrl`. */
export function groundedRows(
	grounding: readonly GroundingEntry[],
): Map<number, RowGrounding> {
	const lookup = new Map<number, RowGrounding>();
	for (const entry of grounding) {
		const index = parseRowIndex(entry.field);
		if (index === null) continue;
		const existing = lookup.get(index);
		lookup.set(index, {
			citations: existing
				? [...existing.citations, ...entry.citations]
				: entry.citations,
			confidence: entry.confidence ?? null,
		});
	}
	return lookup;
}

function confidenceRank(confidence: Confidence | null): number {
	return confidence === null ? -1 : CONFIDENCE_RANK[confidence];
}

function missingRequiredField(row: CompanyRow): boolean {
	return REQUIRED_FIELDS.some((field) => row[field] === null);
}

function normalizeText(value: string): string {
	return value.trim().toLowerCase();
}

function echoesQuery(row: CompanyRow, query: string | undefined): boolean {
	if (query === undefined) return false;
	const target = normalizeText(query);
	return FIELD_NAMES.some((field) => {
		const value = row[field];
		return value !== null && normalizeText(value) === target;
	});
}

function dateRejectReason(
	evidenceDate: string | null,
	freshnessDays: number,
): RejectReason | null {
	if (evidenceDate === null) return null;
	const parsed = new Date(evidenceDate);
	if (Number.isNaN(parsed.getTime())) return "bad-date";
	const cutoff = Date.now() - freshnessDays * MS_PER_DAY;
	return parsed.getTime() < cutoff ? "stale-evidence" : null;
}

function rejectReason(
	row: CompanyRow,
	grounding: RowGrounding | undefined,
	opts: GateOptions,
): RejectReason | null {
	if (missingRequiredField(row)) return "missing-required";
	if (echoesQuery(row, opts.query)) return "echoes-query";
	if (!grounding) return "ungrounded";
	const floor = opts.confidenceFloor ?? "medium";
	if (confidenceRank(grounding.confidence) < confidenceRank(floor))
		return "low-confidence";
	const dateReason = dateRejectReason(row.evidenceDate, opts.freshnessDays);
	if (dateReason) return dateReason;
	const domain = row.domain;
	if (domain === null) return "missing-required";
	return opts.seenDomains.has(normalizeDomain(domain)) ? "already-seen" : null;
}

/** Drops a row for a missing required field, a field that echoes the search query, missing or below-floor grounding, stale or malformed evidence, or an already-seen domain. */
export function gate(
	rows: readonly CompanyRow[],
	grounding: readonly GroundingEntry[],
	opts: GateOptions,
): GateResult {
	const lookup = groundedRows(grounding);
	const kept: CompanyRow[] = [];
	const rejects: Reject[] = [];
	rows.forEach((row, index) => {
		const reason = rejectReason(row, lookup.get(index), opts);
		if (reason) rejects.push({ index, reason });
		else kept.push(row);
	});
	return { kept, rejects };
}
