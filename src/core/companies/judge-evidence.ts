import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import {
	type Condition,
	conditionDateAllowed,
	conditionRefs,
	type Requirement,
} from "@/core/requirements";

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
	sourceUrl: z.string().nullable(),
	date: z.string().nullable(),
});

const VerdictSchema = z.object({
	index: z.number().int().nonnegative(),
	statuses: z.array(StatusSchema),
	reason: z.string(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export type SupportedStatus = z.infer<typeof StatusSchema>;

export const JudgeModelSchema = z.object({
	verdicts: z.array(VerdictSchema),
});

/** One page a search proved for one requirement id, so the judge can weigh a second or third hard page requirement on its own evidence rather than only the first. */
export type RequirementEvidence = {
	url: string;
	quote: string;
	publishedDate?: string | null;
	text?: string;
	identityAllowed?: boolean;
};

export type EvidenceByRow = ReadonlyMap<
	number,
	ReadonlyMap<string, RequirementEvidence>
>;

export type JudgedFields = Omit<CompanyRow, "linkedinUrl"> & {
	pageEvidence?: Record<string, Omit<RequirementEvidence, "identityAllowed">>;
};

/** The company record and retrieved source evidence supplied to the judge. */
export function judgedFields(
	row: CompanyRow,
	extra: ReadonlyMap<string, RequirementEvidence> | undefined,
): JudgedFields {
	return {
		name: row.name,
		domain: row.domain,
		record: row.record,
		description: row.description?.slice(0, JUDGE_DESCRIPTION_CHARS) ?? null,
		...(extra?.size
			? {
					pageEvidence: Object.fromEntries(
						[...extra].map(([key, page]) => [
							key,
							{
								url: page.url,
								quote: "",
								text:
									page.text?.slice(0, config.companies.contentsMaxCharacters) ??
									"",
								publishedDate: page.publishedDate ?? null,
							},
						]),
					),
				}
			: {}),
	};
}

function sourceText(
	sourceUrl: string | null,
	row: CompanyRow | undefined,
	page: RequirementEvidence | undefined,
): string {
	if (sourceUrl !== null) return page?.text ?? "";
	return row?.record ? JSON.stringify(row.record) : "";
}

function evidenceDate(
	condition: Condition,
	entry: SupportedStatus,
	page: RequirementEvidence | undefined,
): string | null {
	return condition.window?.appliesTo === "publication"
		? (page?.publishedDate?.slice(0, 10) ?? entry.date)
		: entry.date;
}

export function supportedStatus(
	entry: SupportedStatus,
	row: CompanyRow | undefined,
	requirements: readonly Requirement[],
	options: {
		evidence: ReadonlyMap<string, RequirementEvidence> | undefined;
		today: string | undefined;
	},
): SupportedStatus {
	const unknown = {
		...entry,
		status: "unproven" as const,
		sourceUrl: null,
		date: null,
	};
	if (entry.status !== "proven") return entry;
	const condition = conditionRefs(requirements).find(
		(ref) => ref.id === entry.id,
	)?.condition;
	if (!condition) return unknown;
	const page = [...(options.evidence?.values() ?? [])].find(
		(source) => source.url === entry.sourceUrl,
	);
	if (!page && (condition.window !== null || condition.sourceRule !== null))
		return unknown;
	const text = sourceText(entry.sourceUrl, row, page);
	if (!text.trim()) return unknown;
	const date = evidenceDate(condition, entry, page);
	return {
		...entry,
		date,
		status: conditionDateAllowed(condition, date, options.today ?? "")
			? "proven"
			: "unproven",
	};
}
