import { config } from "@/config";
import type { FindCompaniesReject } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { verifiedLinkedInCompanyUrl } from "@/core/companies/identity";
import type {
	EvidenceByRow,
	RequirementEvidence,
	RequirementStatus,
	Verdict,
} from "@/core/companies/judge-evidence";
import {
	JudgeModelSchema,
	judgedFields,
	REQUIREMENT_STATUSES,
	supportedStatus,
} from "@/core/companies/judge-evidence";
import { addPartialSpend, CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import { generateStructured, reasoningModel } from "@/core/model";
import type { ConditionRef, Requirement } from "@/core/requirements";
import {
	requiredConditionRefs,
	requiredGroupSatisfied,
	requiredSatisfied,
	requirementLine,
} from "@/core/requirements";
import type { IcpDoc } from "@/core/synthesize";

export type { RequirementEvidence, RequirementStatus, Verdict };
export { REQUIREMENT_STATUSES };

const JUDGE_CACHE_TTL_SECONDS = config.judge.cacheTtlSeconds;
const JUDGE_BATCH_SIZE = config.companies.judgeBatchSize;

export type JudgeResult = {
	verdicts: Verdict[];
	ledger: CostLedger;
};

export type JudgeOptions = {
	evidenceByRow?: EvidenceByRow;
	today?: string;
	profile?: IcpDoc;
};

const JUDGE_INSTRUCTIONS = [
	"Judge company fit from the indexed record and retrieved page text. Description is discovery context; a generated claim or quote is not evidence.",
	"Required groups rN are ANDed; alternatives aN are ORed; conditions cN within an alternative are ANDed. Establish every condition of at least one alternative for each required group. Preferences never exclude.",
	"Return statuses only for conditions established or contradicted by the evidence. Omitted conditions are unproven; do not enumerate unsupported alternatives or preferences.",
	"For proven conditions cite a retrieved sourceUrl. Null sourceUrl is allowed only for directly stated indexed-record facts with no source or date restriction. Establish every clause of the condition: related categories, skill/tool tags or headcounts do not establish deployment, operational scale, ownership or signup requirements.",
	"Apply competitor exclusions to the scoped offer. Using or integrating verification, payments or other capabilities does not itself make a company a competing vendor; establish what it sells.",
	"Infer company categories from concrete operating activities; an exact category label is unnecessary. Do not add requirements for independence, exclusivity, or a core business unless specified. A marketing contrast with traditional providers does not itself negate category membership. Concrete technology, identity, numeric and date claims still need direct evidence.",
	"For dated conditions give the relevant YYYY-MM-DD date. Distinguish event, publication and observation; a profile update is not a role-start date, and a careers page is not a dated vacancy. Unsupported dates stay null.",
	"Vendor case studies are valid evidence for the customer they describe.",
	"Return each row by index with a concise reason naming the decisive supporting or missing facts. Acquisition alone does not prove a business stopped operating; apply the actual exclusions.",
].join(" ");

function judgePrompt(input: {
	requirements: readonly Requirement[];
	rows: readonly CompanyRow[];
	offset: number;
	evidenceByRow: EvidenceByRow;
	today: string | undefined;
	profile: IcpDoc | undefined;
}): string {
	const { requirements, rows, offset, evidenceByRow, today, profile } = input;
	const conditions = requiredConditionRefs(requirements);
	const lines = [
		...(today ? [`Today is ${today}.`] : []),
		...(profile
			? [`Offer in scope: ${profile.icp.offer ?? "unspecified"}`]
			: []),
		"Requirements needing a status:",
		...conditions.map((ref) => `${ref.kind}: ${requirementLine(ref)}`),
	];
	lines.push("Rows:");
	for (const [index, row] of rows.entries()) {
		const fields = judgedFields(row, evidenceByRow.get(offset + index));
		lines.push(`${index}: ${JSON.stringify(fields)}`);
	}
	return lines.join("\n");
}

const FALLBACK_REASON =
	"the judge produced nothing usable, so required conditions remain unproven";

type JudgeSlice = { rows: CompanyRow[]; offset: number };

/** Splits gated rows into slices of at most `JUDGE_BATCH_SIZE`, each carrying the offset its local indices must be shifted by to land back on the full row list. */
export function judgeSlices(rows: readonly CompanyRow[]): JudgeSlice[] {
	const slices: JudgeSlice[] = [];
	for (let offset = 0; offset < rows.length; offset += JUDGE_BATCH_SIZE) {
		slices.push({
			rows: rows.slice(offset, offset + JUDGE_BATCH_SIZE),
			offset,
		});
	}
	return slices;
}

/** Missing structured verdicts leave required conditions unproven. */
function unjudgedSlice(
	slice: JudgeSlice,
	requirements: readonly Requirement[],
): Verdict[] {
	const statuses = requiredConditionRefs(requirements).map((req) => ({
		id: req.id,
		status: "unproven" as const,
		sourceUrl: null,
		date: null,
	}));
	return slice.rows.map((_row, index) => ({
		index: index + slice.offset,
		statuses,
		reason: FALLBACK_REASON,
	}));
}

function shiftVerdicts(
	slice: JudgeSlice,
	verdicts: readonly Verdict[],
): Verdict[] {
	return verdicts
		.filter((verdict) => verdict.index < slice.rows.length)
		.map((verdict) => ({ ...verdict, index: verdict.index + slice.offset }));
}

type JudgeContext = {
	requirements: readonly Requirement[];
	env: Env;
	model: Awaited<ReturnType<typeof reasoningModel>>;
	ledger: CostLedger;
	evidenceByRow: EvidenceByRow;
	today: string | undefined;
	profile: IcpDoc | undefined;
};

async function judgeSlice(
	ctx: JudgeContext,
	slice: JudgeSlice,
): Promise<Verdict[]> {
	const output = await generateStructured(
		{
			model: ctx.model,
			configuredId: ctx.env.MODEL_ROUTE_REASONING,
			instructions: JUDGE_INSTRUCTIONS,
			prompt: judgePrompt({
				requirements: ctx.requirements,
				rows: slice.rows,
				offset: slice.offset,
				evidenceByRow: ctx.evidenceByRow,
				today: ctx.today,
				profile: ctx.profile,
			}),
			schema: JudgeModelSchema,
			reasoningEffort: "medium",
			headers: { "cf-aig-cache-ttl": String(JUDGE_CACHE_TTL_SECONDS) },
		},
		ctx.ledger,
		"judge",
	);
	return output
		? shiftVerdicts(
				slice,
				output.verdicts.map((verdict) => ({
					...verdict,
					statuses: verdict.statuses.map((entry) =>
						supportedStatus(
							entry,
							slice.rows[verdict.index],
							ctx.requirements,
							{
								evidence: ctx.evidenceByRow.get(slice.offset + verdict.index),
								today: ctx.today,
							},
						),
					),
				})),
			)
		: unjudgedSlice(slice, ctx.requirements);
}

/** Judges source-backed company batches, preserving reported costs if a batch fails. */
export async function judge(
	requirements: readonly Requirement[],
	rows: readonly CompanyRow[],
	env: Env,
	options: JudgeOptions = {},
): Promise<JudgeResult> {
	const evidenceByRow = options.evidenceByRow ?? new Map();
	const ledger = new CostLedger();
	const ctx: JudgeContext = {
		requirements,
		env,
		model: await reasoningModel(env),
		ledger,
		evidenceByRow,
		today: options.today,
		profile: options.profile,
	};
	const verdictsBySlice = await Promise.allSettled(
		judgeSlices(rows).map((slice) => judgeSlice(ctx, slice)),
	);
	const failure = verdictsBySlice.find(
		(result) => result.status === "rejected",
	);
	if (failure?.status === "rejected")
		throw addPartialSpend(failure.reason, ledger.total());
	return {
		verdicts: verdictsBySlice.flatMap((result) =>
			result.status === "fulfilled" ? result.value : [],
		),
		ledger,
	};
}

export type Decision = {
	stored: CompanyRow[];
	rejects: FindCompaniesReject[];
};

function statusOf(verdict: Verdict | undefined, id: string): RequirementStatus {
	return (
		verdict?.statuses.find((entry) => entry.id === id)?.status ?? "unproven"
	);
}

/** Identifies an unmet condition in an unsatisfied required group. */
function unprovenRequirement(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): ConditionRef | null {
	const statuses = new Map(
		(verdict?.statuses ?? []).map((status) => [status.id, status.status]),
	);
	return (
		requiredConditionRefs(requirements).find((ref) => {
			const group = requirements[ref.groupIndex];
			return (
				group !== undefined &&
				!requiredGroupSatisfied(group, ref.groupIndex, statuses) &&
				statusOf(verdict, ref.id) !== "proven"
			);
		}) ?? null
	);
}

/**
 * Whether one judged row is stored.
 * Returns true if the judge produced a verdict for the row, no hard requirement is contradicted, and no page-gated requirement is unproven.
 */
function keepsRow(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): boolean {
	return (
		verdict !== undefined &&
		verdict.reason.trim().length > 0 &&
		requiredSatisfied(
			requirements,
			new Map(verdict.statuses.map((status) => [status.id, status.status])),
		)
	);
}

function refusalReason(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): string {
	if (verdict === undefined)
		return "the judge produced no verdict for this row";
	if (
		verdict.reason.trim().length === 0 &&
		requiredSatisfied(
			requirements,
			new Map(verdict.statuses.map((status) => [status.id, status.status])),
		)
	)
		return "the judge produced no selection reason";
	const detail =
		verdict.reason.length > 0 ? verdict.reason : "the judge gave no reason";
	const missing = unprovenRequirement(requirements, verdict);
	if (missing && statusOf(verdict, missing.id) === "contradicted")
		return `contradicts ${missing.id}: ${detail}`;
	return `the required condition ${missing?.id ?? "a required condition"} was not proven: ${detail}`;
}

/** Recovery targets the original unmet group, including all of its allowed alternatives. */
function refusalGroup(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): string {
	const missing = unprovenRequirement(requirements, verdict);
	return missing
		? `proof gap for required group r${missing.groupIndex + 1}`
		: "missing usable qualification verdict";
}

export type DecideInput = {
	requirements: readonly Requirement[];
	rows: readonly CompanyRow[];
	verdicts: readonly Verdict[];
	excluded: ReadonlySet<string>;
	excludedLinkedInUrls?: ReadonlySet<string>;
};

function excludedDomain(
	row: CompanyRow,
	excluded: ReadonlySet<string>,
): boolean {
	return row.domain !== null && excluded.has(normalizeDomain(row.domain));
}

/** Apply fit requirements, exact domain exclusions, and provider LinkedIn deduplication. */
export function decideRows(input: DecideInput): Decision {
	const { requirements, rows, verdicts, excluded } = input;
	const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
	const excludedIdentities: ReadonlySet<string | null> = new Set(
		[
			...(input.excludedLinkedInUrls ?? []),
			...rows
				.filter((row) => excludedDomain(row, excluded))
				.map((row) => row.linkedinUrl),
		]
			.map(verifiedLinkedInCompanyUrl)
			.filter((url): url is string => url !== null),
	);
	const acceptedIdentities = new Set<string>();
	const stored: CompanyRow[] = [];
	const rejects: FindCompaniesReject[] = [];
	rows.forEach((row, index) => {
		const verdict = byIndex.get(index);
		const linkedinUrl = verifiedLinkedInCompanyUrl(row.linkedinUrl);
		if (excludedDomain(row, excluded) || excludedIdentities.has(linkedinUrl)) {
			rejects.push({
				domain: row.domain,
				reason: "already found for this account",
				stage: "gate",
				group: "a company this account already holds",
			});
			return;
		}
		if (!linkedinUrl) {
			rejects.push({
				domain: row.domain,
				reason:
					"company website and LinkedIn identity were not verified by the provider",
				stage: "gate",
			});
			return;
		}
		if (!keepsRow(requirements, verdict)) {
			rejects.push({
				domain: row.domain,
				reason: refusalReason(requirements, verdict),
				stage: "judge",
				group: refusalGroup(requirements, verdict),
				statuses: verdict?.statuses ?? [],
			});
			return;
		}
		if (acceptedIdentities.has(linkedinUrl)) {
			rejects.push({
				domain: row.domain,
				reason:
					"the same provider LinkedIn identity as another accepted company in this round",
				stage: "gate",
				group: "one company under more than one domain",
			});
			return;
		}
		acceptedIdentities.add(linkedinUrl);
		stored.push({ ...row, linkedinUrl });
	});
	return { stored, rejects };
}

/** The share of a round's candidates whose hard page requirements the judge proved, as words the next round's planner reads. Null when the profile asks for no page proof. */
export function provenRate(
	requirements: readonly Requirement[],
	verdicts: readonly Verdict[],
): string | null {
	if (verdicts.length === 0) return null;
	const proven = verdicts.filter((verdict) =>
		requiredSatisfied(
			requirements,
			new Map(verdict.statuses.map((status) => [status.id, status.status])),
		),
	).length;
	return `${proven} of ${verdicts.length}`;
}
