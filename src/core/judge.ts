import { z } from "zod";
import { CostLedger } from "@/core/cost";
import type { CompanyRow } from "@/core/gate";
import { generateStructured, reasoningModel } from "@/core/model";
import type { IcpDoc } from "@/core/synthesize";

const JUDGE_CACHE_TTL_SECONDS = 86_400;

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
	"Return one verdict per row, in the same order, each carrying the row index, a keep",
	"decision, and a short reason.",
].join(" ");

function judgePrompt(icp: IcpDoc, rows: readonly CompanyRow[]): string {
	const criteria = [`Ideal customer profile:`, icp.description];
	const numbered = rows.map((row, index) => `${index}: ${JSON.stringify(row)}`);
	return [...criteria, "Rows:", ...numbered].join("\n");
}

function keepEveryGatedRow(
	rows: readonly CompanyRow[],
	ledger: CostLedger,
): JudgeResult {
	return {
		verdicts: rows.map((_, index) => ({
			index,
			keep: true,
			reason: "model unavailable, the gate decision stands",
		})),
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
): Promise<JudgeResult> {
	const ledger = new CostLedger();
	const output = await generateStructured(
		{
			model: await reasoningModel(env),
			configuredId: env.MODEL_ROUTE_REASONING,
			instructions: JUDGE_INSTRUCTIONS,
			prompt: judgePrompt(icp, rows),
			schema: JudgeModelSchema,
			headers: { "cf-aig-cache-ttl": String(JUDGE_CACHE_TTL_SECONDS) },
		},
		ledger,
		"judge",
	);
	if (!output) return keepEveryGatedRow(rows, ledger);
	return { verdicts: output.verdicts, ledger };
}
