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

export type UnlabelledCompany = {
	domain: string;
	name: string | null;
	description: string | null;
};

export type FitReadingVerdict = "fits" | "unclear" | "does-not-fit";
export type FitReading = { verdict: FitReadingVerdict; reason: string };

/** What the model reading an unlabelled company is asked, hashed into a manifest so a run records exactly what it read from. */
export const FIT_READING_PROMPT = [
	"You read one company's record and the profile it was found for.",
	"Answer fits, unclear, or does-not-fit, with one reason of twenty-five words or fewer.",
	"Answer unclear only when the record genuinely lacks the facts to decide either way.",
].join(" ");

export type ReadFit = (company: UnlabelledCompany) => Promise<FitReading>;

const FIT_SCORE: Record<FitReadingVerdict, number> = {
	fits: 1,
	unclear: 0.5,
	"does-not-fit": 0,
};

/**
 * A model's reading of one unlabelled stored company, to help a human
 * decide which company to label first. Diagnostic only: this score never
 * reaches `computeVerdict` and never gates a run. `readFit` is passed in
 * rather than closed over, so a test can read without calling a model.
 */
export async function fitReading(
	readFit: ReadFit,
	company: UnlabelledCompany,
): Promise<{ domain: string; score: number; reason: string }> {
	const reading = await readFit(company);
	return {
		domain: company.domain,
		score: FIT_SCORE[reading.verdict],
		reason: reading.reason,
	};
}
