import type { Verdict } from "@eval/headline";

export type TrialOutput = {
	verdict: Verdict | null;
	runId: string | null;
	skipped: string | null;
};

export type Score = { name: string; score: number | null };

/** 1 when every correctness gate held, 0 when any failed, null for a trial the budget skipped before it ran. */
export function gatesPass({ output }: { output: TrialOutput }): Score | null {
	if (!output.verdict) return null;
	return { name: "gates_pass", score: output.verdict.allGatesPass ? 1 : 0 };
}

/** The fraction of the key's accepted companies this trial's stored companies covered, null when the key has none accepted yet or the trial was skipped. */
export function qualifiedCoverage({
	output,
}: {
	output: TrialOutput;
}): Score | null {
	if (!output.verdict || output.verdict.qualifiedCoverage === null) return null;
	return {
		name: "qualified_coverage",
		score: output.verdict.qualifiedCoverage,
	};
}

export const CODE_SCORERS = [gatesPass, qualifiedCoverage];
