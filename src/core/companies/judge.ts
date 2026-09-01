import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import { generateStructured, reasoningModel } from "@/core/model";
import type { IcpDoc } from "@/core/synthesize";

const JUDGE_CACHE_TTL_SECONDS = config.judge.cacheTtlSeconds;

const VerdictSchema = z.object({
	index: z.number().int().nonnegative(),
	keep: z.boolean(),
	reason: z.string().optional(),
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
	"decision. Give a short reason only when you refuse a row. Omit the reason when you keep",
	"a row.",
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

function keepEveryGatedRow(
	rows: readonly CompanyRow[],
	ledger: CostLedger,
): JudgeResult {
	return {
		verdicts: rows.map((_, index) => ({ index, keep: true })),
		ledger,
	};
}

/**
 * Judges one batch of gate-passed rows against the ICP document in a
 * single call. Falls back to keeping every row when the model produces
 * nothing usable twice in a row.
 */
export async function judge(
	icp: IcpDoc,
	rows: readonly CompanyRow[],
	env: Env,
	recency: string | null,
): Promise<JudgeResult> {
	const ledger = new CostLedger();
	const output = await generateStructured(
		{
			model: await reasoningModel(env),
			configuredId: env.MODEL_ROUTE_REASONING,
			instructions: JUDGE_INSTRUCTIONS,
			prompt: judgePrompt(icp, rows, recency),
			schema: JudgeModelSchema,
			headers: { "cf-aig-cache-ttl": String(JUDGE_CACHE_TTL_SECONDS) },
		},
		ledger,
		"judge",
	);
	if (!output) return keepEveryGatedRow(rows, ledger);
	return { verdicts: output.verdicts, ledger };
}
