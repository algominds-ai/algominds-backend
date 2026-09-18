import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { FindCompaniesDeps } from "@/core/companies";
import type { CompanyRow } from "@/core/companies/gate";
import type { JudgeOptions, Verdict } from "@/core/companies/judge";
import { judge, judgeSlices } from "@/core/companies/judge";
import type {
	EvidenceByRow,
	RequirementEvidence,
} from "@/core/companies/judge-evidence";
import { judgeInputEvidenceRows } from "@/core/companies/rows";
import { addPartialSpend, CostLedger } from "@/core/cost";
import { appendEvidence } from "@/core/db/queries";
import type { Requirement } from "@/core/requirements";
import { durablePurchase } from "@/workflows/durable-purchase";

type SaveJudgeInput = {
	step: WorkflowStep;
	round: number;
	runId: string;
	env: Env;
	requirements: readonly Requirement[];
	rows: readonly CompanyRow[];
	evidenceByRow: EvidenceByRow;
};

async function saveJudgeInput(input: SaveJudgeInput): Promise<void> {
	const { step, round, runId, env, requirements, rows, evidenceByRow } = input;
	await step.do(
		`round_${round}-judge-input`,
		config.stepConfig.databaseCall,
		() =>
			appendEvidence(
				env,
				judgeInputEvidenceRows({
					runId,
					round,
					rows,
					evidenceByRow,
					requirements,
				}),
			),
	);
}

function evidenceForSlice(
	evidenceByRow: EvidenceByRow,
	offset: number,
	length: number,
): EvidenceByRow {
	const local = new Map<number, Map<string, RequirementEvidence>>();
	for (let index = 0; index < length; index += 1) {
		const evidence = evidenceByRow.get(offset + index);
		if (evidence) local.set(index, new Map(evidence));
	}
	return local;
}

function shiftSliceVerdicts(
	verdicts: readonly Verdict[],
	offset: number,
): Verdict[] {
	return verdicts.map((verdict) => ({
		...verdict,
		index: verdict.index + offset,
	}));
}

function failureCost(error: unknown): number {
	return error instanceof Error &&
		"costDollars" in error &&
		typeof error.costDollars === "number"
		? error.costDollars
		: 0;
}

async function judgeSliceStep(input: {
	step: WorkflowStep;
	round: number;
	slice: { rows: CompanyRow[]; offset: number };
	requirements: readonly Requirement[];
	env: Env;
	options: JudgeOptions;
	evidenceByRow: EvidenceByRow;
	ledger: CostLedger;
}): Promise<{ verdicts: Verdict[] }> {
	const {
		step,
		round,
		slice,
		requirements,
		env,
		options,
		evidenceByRow,
		ledger,
	} = input;
	const evidenceBySlice = evidenceForSlice(
		evidenceByRow,
		slice.offset,
		slice.rows.length,
	);
	return durablePurchase(
		{
			step,
			name: `round_${round}-judge-${slice.offset}`,
			budget: "judgeCall",
			ledger,
		},
		async (stepLedger) => {
			const result = await judge(requirements, slice.rows, env, {
				...options,
				evidenceByRow: evidenceBySlice,
				ledger: stepLedger,
			});
			return { verdicts: result.verdicts };
		},
	);
}

function mergeJudgeOutcomes(
	outcomes: PromiseSettledResult<{ verdicts: Verdict[] }>[],
	slices: { offset: number }[],
): { verdicts: Verdict[]; failures: unknown[]; failedCost: number } {
	const verdicts: Verdict[] = [];
	const failures: unknown[] = [];
	let failedCost = 0;
	for (const [index, outcome] of outcomes.entries()) {
		const slice = slices[index];
		if (!slice) continue;
		if (outcome.status === "fulfilled") {
			verdicts.push(
				...shiftSliceVerdicts(outcome.value.verdicts, slice.offset),
			);
			continue;
		}
		failures.push(outcome.reason);
		failedCost += failureCost(outcome.reason);
	}
	return { verdicts, failures, failedCost };
}

export function steppedJudge(
	step: WorkflowStep,
	round: number,
	runId: string,
): FindCompaniesDeps["judge"] {
	return async (requirements, rows, env, options: JudgeOptions = {}) => {
		const evidenceByRow = options.evidenceByRow ?? new Map();
		await saveJudgeInput({
			step,
			round,
			runId,
			env,
			requirements,
			rows,
			evidenceByRow,
		});
		const ledger = new CostLedger();
		const slices = judgeSlices(rows);
		const outcomes = await Promise.allSettled(
			slices.map((slice) =>
				judgeSliceStep({
					step,
					round,
					slice,
					requirements,
					env,
					options,
					evidenceByRow,
					ledger,
				}),
			),
		);
		const { verdicts, failures, failedCost } = mergeJudgeOutcomes(
			outcomes,
			slices,
		);
		if (failures.length > 0) {
			const first = failures[0];
			throw addPartialSpend(
				first,
				ledger.total() + Math.max(0, failedCost - failureCost(first)),
			);
		}
		return { verdicts, ledger };
	};
}
