import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import type { Requirement } from "@/core/requirements";
import { mustBeProven } from "@/core/requirements";

const JUDGE_DESCRIPTION_CHARS = config.companies.descriptionChars;

export const REQUIREMENT_STATUSES = [
	"proven",
	"unproven",
	"contradicted",
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

const StatusSchema = z.object({
	id: z.string(),
	status: z.enum(REQUIREMENT_STATUSES),
	quote: z.string(),
});

const VerdictSchema = z.object({
	index: z.number().int().nonnegative(),
	statuses: z.array(StatusSchema),
	reason: z.string(),
	sameOrganizationAs: z.number().int().nonnegative().nullable(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export const JudgeModelSchema = z.object({
	verdicts: z.array(VerdictSchema),
});

/** One page a search proved for one requirement id, so the judge can weigh a second or third hard page requirement on its own evidence rather than only the first. */
export type RequirementEvidence = { url: string; quote: string };

export type EvidenceByRow = ReadonlyMap<
	number,
	ReadonlyMap<string, RequirementEvidence>
>;

export type JudgedFields = {
	name: string | null;
	domain: string | null;
	description: string | null;
	evidenceUrl?: string;
	evidenceQuote?: string;
	pageEvidence?: Record<string, RequirementEvidence>;
};

/** The row cut to only the fields the judge instructions read: its own record, and the page it cites when it cites one. Everything else — signal, dates, publisher, the kind label — never changes a verdict. */
export function judgedFields(
	row: CompanyRow,
	extra: ReadonlyMap<string, RequirementEvidence> | undefined,
): JudgedFields {
	return {
		name: row.name,
		domain: row.domain,
		description:
			row.description === null
				? null
				: row.description.slice(0, JUDGE_DESCRIPTION_CHARS),
		...(row.evidenceUrl !== null ? { evidenceUrl: row.evidenceUrl } : {}),
		...(row.evidenceQuote !== null ? { evidenceQuote: row.evidenceQuote } : {}),
		...(extra && extra.size > 0
			? { pageEvidence: Object.fromEntries(extra) }
			: {}),
	};
}

function evidencePassages(fields: JudgedFields): string[] {
	const quotes = fields.pageEvidence
		? Object.values(fields.pageEvidence).map((entry) => entry.quote)
		: [];
	return [fields.description, fields.evidenceQuote, ...quotes].filter(
		(value): value is string => value !== null && value !== undefined,
	);
}

function normalizedWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Whether the quote occurs verbatim inside one single evidence passage, so a quote cannot be assembled by joining two of them. */
function quoteFoundIn(quote: string, passages: readonly string[]): boolean {
	if (quote.trim().length === 0) return false;
	const normalizedQuote = normalizedWhitespace(quote);
	return passages.some((passage) =>
		normalizedWhitespace(passage).includes(normalizedQuote),
	);
}

export type GroundingInput = {
	requirements: readonly Requirement[];
	rows: readonly CompanyRow[];
	evidenceByRow: EvidenceByRow;
	offset: number;
};

/**
 * Downgrades a `proven` status on a requirement in `mustBeProven` to
 * `unproven` when its quote is missing or does not occur verbatim in that
 * row's own evidence text, so a strict or page requirement cannot be proven
 * on a reading the row's evidence never states.
 */
export function withGroundedProof(
	input: GroundingInput,
	verdicts: readonly Verdict[],
): Verdict[] {
	const groundedIds = new Set(
		mustBeProven(input.requirements).map((req) => req.id),
	);
	if (groundedIds.size === 0) return [...verdicts];
	return verdicts.map((verdict) => {
		const row = input.rows[verdict.index];
		if (row === undefined) return verdict;
		const passages = evidencePassages(
			judgedFields(row, input.evidenceByRow.get(input.offset + verdict.index)),
		);
		return {
			...verdict,
			statuses: verdict.statuses.map((entry) =>
				groundedIds.has(entry.id) &&
				entry.status === "proven" &&
				!quoteFoundIn(entry.quote, passages)
					? { ...entry, status: "unproven" as const }
					: entry,
			),
		};
	});
}
