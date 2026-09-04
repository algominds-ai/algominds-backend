import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import { generateStructured, reasoningModel } from "@/core/model";
import type { Requirement } from "@/core/requirements";
import { hardRequirements, requirementLine } from "@/core/requirements";

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

const JUDGE_INSTRUCTIONS = [
	"For every row, by index, return one status per id: `proven` when the row's record or",
	"evidence establishes it; `contradicted` when they show the row is what the requirement",
	"excludes or not what it requires, e.g. selling IT services contradicts an IT-services",
	"exclusion; `unproven` when they say nothing either way, e.g. silence on hiring is",
	"unproven, not contradicted, for hiring.",
	"A row's evidence page proves a requirement only when the quote is about the company the",
	"row names and the page records it; a quote about another company proves nothing.",
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
};

/** The row cut to only the fields the judge instructions read: its own record, and the page it cites when it cites one. Everything else — signal, dates, publisher, the kind label — never changes a verdict. */
function judgedFields(row: CompanyRow): JudgedFields {
	return {
		name: row.name,
		domain: row.domain,
		description:
			row.description === null
				? null
				: row.description.slice(0, JUDGE_DESCRIPTION_CHARS),
		...(row.evidenceUrl !== null ? { evidenceUrl: row.evidenceUrl } : {}),
		...(row.evidenceQuote !== null ? { evidenceQuote: row.evidenceQuote } : {}),
	};
}

function judgePrompt(
	requirements: readonly Requirement[],
	rows: readonly CompanyRow[],
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
		lines.push(`${index}: ${JSON.stringify(judgedFields(row))}`);
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
			prompt: judgePrompt(ctx.requirements, slice.rows),
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
 * unproven rather than failing the whole batch.
 */
export async function judge(
	requirements: readonly Requirement[],
	rows: readonly CompanyRow[],
	env: Env,
): Promise<JudgeResult> {
	const ledger = new CostLedger();
	const ctx: JudgeContext = {
		requirements,
		env,
		model: await reasoningModel(env),
		ledger,
	};
	const verdictsBySlice = await Promise.all(
		judgeSlices(rows).map((slice) => judgeSlice(ctx, slice)),
	);
	return { verdicts: verdictsBySlice.flat(), ledger };
}
