import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import { generateStructured, reasoningModel } from "@/core/model";
import type { IcpDoc } from "@/core/synthesize";

const JUDGE_CACHE_TTL_SECONDS = config.judge.cacheTtlSeconds;
const JUDGE_BATCH_SIZE = config.companies.judgeBatchSize;

const VerdictSchema = z.object({
	index: z.number().int().nonnegative(),
	keep: z.boolean(),
	reason: z.string(),
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
	"You judge one batch of candidate companies against an ideal customer profile in a single",
	"pass. For every row, by its index, decide whether it should keep going toward a campaign.",
	"Return one verdict per row, in the same order, each carrying the row index and a keep",
	"decision. Give a one-sentence reason for every row, kept or refused, of about twenty five",
	"words or fewer, in plain text describing only what that row's own fields show: never",
	"invent a fact the row does not carry.",
	"A row may carry the page its signal came from: `evidenceUrl`, `evidenceQuote` copied",
	"word for word from that page, and `evidencePublisher` as the page names itself. When a",
	"row carries them, weigh them: refuse a row whose page records nothing about the company",
	"it names, whose quote is about a different company, or whose page names no publisher at",
	"all. A page published by a named organisation counts even when that organisation is not",
	"the company, so a news publication, a job board the company plainly uses, and a status",
	"provider are all credible records.",
	"A row carrying no quote and no publisher came from a source that does not produce them,",
	"because the profile asked for no recent event. Judge it on the profile and the",
	"company's own record, and never refuse it for their absence.",
	"A row whose `evidenceDate` falls outside the freshness window never reaches you, so",
	"every date you see is inside it. A row carrying no `evidenceDate` does reach you, and",
	"whether it still proves the signal depends on what the page is. A page that is only",
	"true while it is published, such as a job advertisement still open or a status page",
	"reporting a live incident, proves the signal now even with no date printed on it. A",
	"page that records something that happened, such as a news article, an announcement or",
	"a postmortem, proves nothing without a date, because you cannot tell when it happened.",
].join(" ");

function judgePrompt(
	icp: IcpDoc,
	rows: readonly CompanyRow[],
	recency: string | null,
): string {
	const criteria = [`Ideal customer profile:`, icp.description];
	if (recency !== null) criteria.push("Freshness window:", recency);
	const numbered = rows.map((row, index) => {
		const { evidenceKind: _kind, ...judged } = row;
		return `${index}: ${JSON.stringify(judged)}`;
	});
	return [...criteria, "Rows:", ...numbered].join("\n");
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

function keepEverySliceRow(slice: JudgeSlice): Verdict[] {
	return slice.rows.map((_, index) => ({
		index: index + slice.offset,
		keep: true,
		reason: FALLBACK_REASON,
	}));
}

function shiftVerdicts(
	slice: JudgeSlice,
	verdicts: readonly Verdict[],
): Verdict[] {
	return verdicts.map((verdict) => ({
		...verdict,
		index: verdict.index + slice.offset,
	}));
}

type JudgeContext = {
	icp: IcpDoc;
	env: Env;
	recency: string | null;
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
			prompt: judgePrompt(ctx.icp, slice.rows, ctx.recency),
			schema: JudgeModelSchema,
			headers: { "cf-aig-cache-ttl": String(JUDGE_CACHE_TTL_SECONDS) },
		},
		ctx.ledger,
		"judge",
	);
	return output
		? shiftVerdicts(slice, output.verdicts)
		: keepEverySliceRow(slice);
}

/**
 * Judges every gate-passed row against the ICP document, in slices of at
 * most `JUDGE_BATCH_SIZE` rows so one call never sends the model more than
 * it can finish inside its own timeout. Every slice runs as its own model
 * call, concurrently, on one shared cost ledger; a slice whose model
 * produces nothing usable twice in a row falls back to keeping its own rows
 * rather than failing the whole batch.
 */
export async function judge(
	icp: IcpDoc,
	rows: readonly CompanyRow[],
	env: Env,
	recency: string | null,
): Promise<JudgeResult> {
	const ledger = new CostLedger();
	const ctx: JudgeContext = {
		icp,
		env,
		recency,
		model: await reasoningModel(env),
		ledger,
	};
	const slices = judgeSlices(rows);
	const verdictsBySlice = await Promise.all(
		slices.map((slice) => judgeSlice(ctx, slice)),
	);
	return { verdicts: verdictsBySlice.flat(), ledger };
}
