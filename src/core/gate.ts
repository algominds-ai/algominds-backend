import { normalizeDomain } from "@/core/db/schema";

export type Citation = {
	url: string;
	title?: string;
};

export type GroundingEntry = {
	field: string;
	citations: Citation[];
	confidence?: "low" | "medium" | "high" | null;
};

const FIELD_NAMES = [
	"name",
	"domain",
	"linkedinUrl",
	"sourceUrl",
	"signal",
	"evidenceDate",
] as const;

export type CompanyField = (typeof FIELD_NAMES)[number];

export type CompanyRow = { [K in CompanyField]: string | null };

export type RejectReason =
	| "ungrounded-required"
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
};

export type GateResult = {
	kept: CompanyRow[];
	rejects: Reject[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Collects every grounding entry's citations under its exact field path. */
export function groundedFields(
	grounding: readonly GroundingEntry[],
): Map<string, Citation[]> {
	const lookup = new Map<string, Citation[]>();
	for (const entry of grounding) {
		const existing = lookup.get(entry.field);
		lookup.set(
			entry.field,
			existing ? [...existing, ...entry.citations] : entry.citations,
		);
	}
	return lookup;
}

function fieldPath(index: number, field: CompanyField): string {
	return `structured.companies[${index}].${field}`;
}

/** Returns the citations grounding `field` at `index`, or `undefined` when no entry matches that exact indexed path. */
export function isGrounded(
	lookup: ReadonlyMap<string, Citation[]>,
	index: number,
	field: CompanyField,
): Citation[] | undefined {
	return lookup.get(fieldPath(index, field));
}

function isUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

function tryNormalizeDomain(value: string): string | null {
	try {
		return normalizeDomain(value);
	} catch {
		return null;
	}
}

/** True for a non-URL value, or a URL value whose registrable domain matches at least one citation. */
export function isRelevant(
	citations: readonly Citation[],
	value: string,
): boolean {
	if (!isUrl(value)) return true;
	const target = normalizeDomain(value);
	return citations.some(
		(citation) => tryNormalizeDomain(citation.url) === target,
	);
}

function groundField(
	lookup: ReadonlyMap<string, Citation[]>,
	index: number,
	field: CompanyField,
	value: string,
): string | null {
	const citations = isGrounded(lookup, index, field);
	if (!citations) return null;
	return isRelevant(citations, value) ? value : null;
}

function groundRow(
	lookup: ReadonlyMap<string, Citation[]>,
	index: number,
	row: CompanyRow,
): CompanyRow {
	const grounded = { ...row };
	for (const field of FIELD_NAMES) {
		const value = row[field];
		if (value !== null)
			grounded[field] = groundField(lookup, index, field, value);
	}
	return grounded;
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

function rejectReason(row: CompanyRow, opts: GateOptions): RejectReason | null {
	if (row.name === null || row.domain === null) return "ungrounded-required";
	const dateReason = dateRejectReason(row.evidenceDate, opts.freshnessDays);
	if (dateReason) return dateReason;
	return opts.seenDomains.has(normalizeDomain(row.domain))
		? "already-seen"
		: null;
}

/** Nulls each ungrounded or off-domain field, then drops a row when a required field, its evidence date, or its domain fails. */
export function gate(
	rows: readonly CompanyRow[],
	grounding: readonly GroundingEntry[],
	opts: GateOptions,
): GateResult {
	const lookup = groundedFields(grounding);
	const kept: CompanyRow[] = [];
	const rejects: Reject[] = [];
	rows.forEach((row, index) => {
		const grounded = groundRow(lookup, index, row);
		const reason = rejectReason(grounded, opts);
		if (reason) rejects.push({ index, reason });
		else kept.push(grounded);
	});
	return { kept, rejects };
}
