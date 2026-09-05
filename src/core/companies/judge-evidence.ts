import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";

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
