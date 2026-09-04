import { z } from "zod";
import { config } from "@/config";
import type { FindCompaniesReject } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import { generateStructured, reasoningModel } from "@/core/model";
import type { Requirement } from "@/core/requirements";
import {
	hardPageRequirements,
	hardRequirements,
	requirementLine,
} from "@/core/requirements";

const JUDGE_CACHE_TTL_SECONDS = config.judge.cacheTtlSeconds;
const JUDGE_BATCH_SIZE = config.companies.judgeBatchSize;
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
	soft: z.array(z.string()),
	reason: z.string(),
	sameOrganizationAs: z.number().int().nonnegative().nullable(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

const JudgeModelSchema = z.object({
	verdicts: z.array(VerdictSchema),
});

export type JudgeResult = {
	verdicts: Verdict[];
	ledger: CostLedger;
};

/** One page a search proved for one requirement id, so the judge can weigh a second or third hard page requirement on its own evidence rather than only the first. */
export type RequirementEvidence = { url: string; quote: string };

type EvidenceByRow = ReadonlyMap<
	number,
	ReadonlyMap<string, RequirementEvidence>
>;

const JUDGE_INSTRUCTIONS = [
	"For every row, by index, return one status per id: `proven` when the row's record or",
	"evidence establishes it; `contradicted` when they show the row is what the requirement",
	"excludes or not what it requires, e.g. selling IT services contradicts an IT-services",
	"exclusion; `unproven` when they say nothing either way, e.g. silence on hiring is",
	"unproven, not contradicted, for hiring.",
	"A row's evidence page proves a requirement only when the quote is about the company the",
	"row names and the page records it; a quote about another company proves nothing.",
	"A row's `pageEvidence` object, when present, gives the quote already found for one or",
	"more requirement ids; an id missing there had no page found for it, so a `page`",
	"requirement with no entry stays unproven unless the record itself settles it.",
	"Give one reason of twenty-five words or fewer describing only what that row's own",
	"fields show, and never invent a fact the row does not carry.",
	"Set `sameOrganizationAs` to the index of an earlier row that is the same organisation",
	"under another brand, country domain or subdomain, and to null otherwise.",
].join(" ");

type JudgedFields = {
	name: string | null;
	domain: string | null;
	description: string | null;
	evidenceUrl?: string;
	evidenceQuote?: string;
	pageEvidence?: Record<string, RequirementEvidence>;
};

/** The row cut to only the fields the judge instructions read: its own record, and the page it cites when it cites one. Everything else — signal, dates, publisher, the kind label — never changes a verdict. */
function judgedFields(
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

function judgePrompt(
	requirements: readonly Requirement[],
	rows: readonly CompanyRow[],
	offset: number,
	evidenceByRow: EvidenceByRow,
): string {
	const hard = hardRequirements(requirements);
	const soft = requirements.filter((req) => req.kind === "soft");
	const lines = [
		"Requirements needing a status:",
		...hard.map(requirementLine),
	];
	if (soft.length > 0) {
		lines.push(
			"Preferences. List in `soft` the ids this row's own fields show, and give no status for these:",
			...soft.map(requirementLine),
		);
	}
	lines.push("Rows:");
	for (const [index, row] of rows.entries()) {
		const fields = judgedFields(row, evidenceByRow.get(offset + index));
		lines.push(`${index}: ${JSON.stringify(fields)}`);
	}
	return lines.join("\n");
}

const FALLBACK_REASON =
	"the judge produced nothing usable, so this row was kept by default";

type JudgeSlice = { rows: CompanyRow[]; offset: number };

/** Splits gated rows into slices of at most `JUDGE_BATCH_SIZE`, each carrying the offset its local indices must be shifted by to land back on the full row list. */
function judgeSlices(rows: readonly CompanyRow[]): JudgeSlice[] {
	const slices: JudgeSlice[] = [];
	for (let offset = 0; offset < rows.length; offset += JUDGE_BATCH_SIZE) {
		slices.push({
			rows: rows.slice(offset, offset + JUDGE_BATCH_SIZE),
			offset,
		});
	}
	return slices;
}

/**
 * Every hard requirement `unproven` for a slice whose model call produced
 * nothing. A row-level fallback cannot claim proof it never saw, so a page
 * requirement stays unproven and the round's own rule decides what that means.
 */
function unjudgedSlice(
	slice: JudgeSlice,
	requirements: readonly Requirement[],
): Verdict[] {
	const statuses = hardRequirements(requirements).map((req) => ({
		id: req.id,
		status: "unproven" as const,
	}));
	return slice.rows.map((_row, index) => ({
		index: index + slice.offset,
		statuses,
		soft: [],
		reason: FALLBACK_REASON,
		sameOrganizationAs: null,
	}));
}

function shiftVerdicts(
	slice: JudgeSlice,
	verdicts: readonly Verdict[],
): Verdict[] {
	return verdicts.map((verdict) => ({
		...verdict,
		index: verdict.index + slice.offset,
		sameOrganizationAs:
			verdict.sameOrganizationAs === null
				? null
				: verdict.sameOrganizationAs + slice.offset,
	}));
}

type JudgeContext = {
	requirements: readonly Requirement[];
	env: Env;
	model: Awaited<ReturnType<typeof reasoningModel>>;
	ledger: CostLedger;
	evidenceByRow: EvidenceByRow;
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
			prompt: judgePrompt(
				ctx.requirements,
				slice.rows,
				slice.offset,
				ctx.evidenceByRow,
			),
			schema: JudgeModelSchema,
			headers: { "cf-aig-cache-ttl": String(JUDGE_CACHE_TTL_SECONDS) },
		},
		ctx.ledger,
		"judge",
	);
	return output
		? shiftVerdicts(slice, output.verdicts)
		: unjudgedSlice(slice, ctx.requirements);
}

/**
 * Judges every gate-passed row against the profile's requirements, in slices
 * of at most `JUDGE_BATCH_SIZE` rows so one call never sends the model more
 * than it can finish inside its own timeout. Every slice runs as its own
 * model call, concurrently, on one shared cost ledger; a slice whose model
 * produces nothing usable twice in a row falls back to every hard requirement
 * unproven rather than failing the whole batch. `evidenceByRow` carries the
 * page a search already proved for a row's other hard page requirements, so
 * only the first ever reaching the row's own single evidence slot does not
 * leave the rest unweighed.
 */
export async function judge(
	requirements: readonly Requirement[],
	rows: readonly CompanyRow[],
	env: Env,
	evidenceByRow: EvidenceByRow = new Map(),
): Promise<JudgeResult> {
	const ledger = new CostLedger();
	const ctx: JudgeContext = {
		requirements,
		env,
		model: await reasoningModel(env),
		ledger,
		evidenceByRow,
	};
	const verdictsBySlice = await Promise.all(
		judgeSlices(rows).map((slice) => judgeSlice(ctx, slice)),
	);
	return { verdicts: verdictsBySlice.flat(), ledger };
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

/** The first hard requirement a row's own record or evidence contradicts, or null when none does. */
function contradictedRequirement(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): Requirement | null {
	return (
		hardRequirements(requirements).find(
			(req) => statusOf(verdict, req.id) === "contradicted",
		) ?? null
	);
}

/** The first hard page requirement no cited page has proven for a row, or null when every one of them is proven. */
function unprovenRequirement(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): Requirement | null {
	return (
		hardPageRequirements(requirements).find(
			(req) => statusOf(verdict, req.id) !== "proven",
		) ?? null
	);
}

/**
 * Whether one judged row is stored. A hard requirement the row contradicts
 * refuses it. A hard requirement that only a page can settle must be `proven`
 * from a cited page, and every row reaches the judge with its evidence already
 * attached, so `unproven` there means no page proved it and the row is
 * refused. A hard requirement the record settles is judged on the record, so
 * `unproven` keeps the row: a record that states nothing is silence, not a
 * contradiction. Soft requirements never gate.
 */
function keepsRow(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): boolean {
	return (
		contradictedRequirement(requirements, verdict) === null &&
		unprovenRequirement(requirements, verdict) === null
	);
}

function refusalReason(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): string {
	const detail = verdict?.reason ?? "the judge gave no reason";
	const bad = contradictedRequirement(requirements, verdict);
	if (bad !== null) return `contradicts ${bad.id}: ${detail}`;
	const missing = unprovenRequirement(requirements, verdict);
	return `no page proved ${missing?.id ?? "a required signal"}: ${detail}`;
}

/**
 * The rows one round's judged batch collapses away: a row the judge marked as
 * the same organisation as another row in the batch, so one group is stored
 * once under one brand. A row naming itself, or an index outside the batch, is
 * not a collapse.
 */
function collapsedIndices(
	verdicts: readonly Verdict[],
	rowCount: number,
): Set<number> {
	const collapsed = new Set<number>();
	for (const verdict of verdicts) {
		const other = verdict.sameOrganizationAs;
		if (other === null || other === verdict.index) continue;
		if (other < 0 || other >= rowCount) continue;
		collapsed.add(verdict.index);
	}
	return collapsed;
}

export type DecideInput = {
	requirements: readonly Requirement[];
	rows: readonly CompanyRow[];
	verdicts: readonly Verdict[];
	excluded: ReadonlySet<string>;
};

/** Whether a row belongs to an organisation this run must not return: its own domain is excluded, or the judge says it is the same organisation as a row whose domain is. */
function excludedRow(
	rows: readonly CompanyRow[],
	index: number,
	verdict: Verdict | undefined,
	excluded: ReadonlySet<string>,
): boolean {
	const own = rows[index]?.domain;
	if (own !== null && own !== undefined && excluded.has(normalizeDomain(own)))
		return true;
	const other = verdict?.sameOrganizationAs;
	if (other === null || other === undefined) return false;
	const parent = rows[other]?.domain;
	return (
		parent !== null &&
		parent !== undefined &&
		excluded.has(normalizeDomain(parent))
	);
}

/**
 * Applies the refusal policy to one judged batch: brand duplicates collapse to
 * one row, a contradicted hard requirement refuses, a hard page requirement no
 * page proved refuses, and everything else is stored.
 */
export function decideRows(input: DecideInput): Decision {
	const { requirements, rows, verdicts, excluded } = input;
	const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
	const collapsed = collapsedIndices(verdicts, rows.length);
	const stored: CompanyRow[] = [];
	const rejects: FindCompaniesReject[] = [];
	rows.forEach((row, index) => {
		const verdict = byIndex.get(index);
		if (excludedRow(rows, index, verdict, excluded)) {
			rejects.push({
				domain: row.domain,
				reason: "already found for this account, or a brand of one that was",
				stage: "gate",
				group: "a company this account already holds",
			});
			return;
		}
		if (collapsed.has(index)) {
			rejects.push({
				domain: row.domain,
				reason: "the same organisation as another company in this round",
				stage: "judge",
				group: "one organisation under more than one brand",
			});
			return;
		}
		if (keepsRow(requirements, verdict)) stored.push(row);
		else
			rejects.push({
				domain: row.domain,
				reason: refusalReason(requirements, verdict),
				stage: "judge",
				statuses: verdict?.statuses ?? [],
			});
	});
	return { stored, rejects };
}

/** The share of a round's candidates whose hard page requirements the judge proved, as words the next round's planner reads. Null when the profile asks for no page proof. */
export function provenRate(
	requirements: readonly Requirement[],
	verdicts: readonly Verdict[],
): string | null {
	if (hardPageRequirements(requirements).length === 0) return null;
	const proven = verdicts.filter(
		(verdict) => unprovenRequirement(requirements, verdict) === null,
	).length;
	return `${proven} of ${verdicts.length}`;
}
