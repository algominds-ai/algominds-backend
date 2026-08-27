import { normalizeDomain } from "@/core/db/schema";

export type SearchResult = {
	publishedDate?: string;
	score?: number;
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

export type RejectReason = "missing-required" | "already-seen";

export type Reject = {
	index: number;
	reason: RejectReason;
};

export type GateOptions = {
	seenDomains: ReadonlySet<string>;
};

export type GateResult = {
	kept: CompanyRow[];
	rejects: Reject[];
};

function missingRequiredField(row: CompanyRow): boolean {
	return REQUIRED_FIELDS.some((field) => row[field] === null);
}

function rejectReason(row: CompanyRow, opts: GateOptions): RejectReason | null {
	if (missingRequiredField(row)) return "missing-required";
	const domain = row.domain;
	if (domain === null) return "missing-required";
	return opts.seenDomains.has(normalizeDomain(domain)) ? "already-seen" : null;
}

/** Drops a row for a missing required field or an already-seen domain. Fit against the profile is the judge's decision, not this function's. */
export function gate(
	rows: readonly CompanyRow[],
	_results: readonly SearchResult[],
	opts: GateOptions,
): GateResult {
	const kept: CompanyRow[] = [];
	const rejects: Reject[] = [];
	rows.forEach((row, index) => {
		const reason = rejectReason(row, opts);
		if (reason) rejects.push({ index, reason });
		else kept.push(row);
	});
	return { kept, rejects };
}
