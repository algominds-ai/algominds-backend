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
export function precision({ output }: { output: TrialOutput }): Score | null {
	if (!output.verdict || output.verdict.precision === null) return null;
	return {
		name: "precision",
		score: output.verdict.precision,
	};
}

export const CODE_SCORERS = [gatesPass, precision];

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

/**
 * The hosted evaluators recorded against a companies/people run's trace
 * span tree described in `docs/solutions/eval.md`.
 * Every choice mapping a hosted evaluator uses lives here, in code, mirrored
 * into the saved Braintrust function rather than defined only in the UI.
 */
export type KeyAcceptedInput = { label: string | null };

/** 1 when the profile's key accepts this stored company, 0 when it rejects it, null when the key has not labelled it yet. Scope: a company span, `expected` carrying the key's own label. */
export function keyAccepted(input: KeyAcceptedInput): number | null {
	if (input.label === "accept") return 1;
	if (input.label?.startsWith("reject:")) return 0;
	return null;
}

export type GateProvenInput = {
	requiresProvingPass: boolean;
	citedPage: string | null;
	evidenceCheck: string | null;
};

/** 1 when the profile demands a hard page requirement and this company's citation checked found, 0 when it demanded one and the check failed or is missing, null when the profile demands no hard page requirement at all. Scope: a company span. */
export function gateProven(input: GateProvenInput): number | null {
	if (!input.requiresProvingPass) return null;
	return input.citedPage !== null && input.evidenceCheck === "found" ? 1 : 0;
}

export const ROUND_ROUTES = ["exa-search", "exa-agent"] as const;

export type RouteMatchesShapeInput = {
	requiresProvingPass: boolean;
	route: string | null;
};

/** 1 when a round's route matches the shape its requirements demand: `exa-search` with no hard page requirement, `exa-agent` with one. Scope: a round span. */
export function routeMatchesShape(input: RouteMatchesShapeInput): number {
	if (input.route === null) return 0;
	const isAgent = input.route === ROUND_ROUTES[1];
	return isAgent === input.requiresProvingPass ? 1 : 0;
}

export const FIT_READING_EVAL_LABELS = [
	"fits",
	"does_not_fit",
	"cannot_tell",
] as const;

export type FitReadingEvalLabel = (typeof FIT_READING_EVAL_LABELS)[number];

/** The score `fit_reading` (the hosted LLM classifier, scope: a company span) maps each of its labels to: `fits` proves the company against the profile, `does_not_fit` refutes it, `cannot_tell` skips the row rather than guessing. */
export const FIT_READING_EVAL_SCORE: Record<
	FitReadingEvalLabel,
	number | null
> = {
	fits: 1,
	does_not_fit: 0,
	cannot_tell: null,
};

export const REACHABILITY_LABELS = [
	"inside_band",
	"above_band",
	"below_band",
] as const;

export const QUERY_QUALITY_LABELS = [
	"describes_the_company",
	"keyword_list",
	"restates_profile",
] as const;

const REQUIREMENT_WORD_MIN_LENGTH = 4;

function contentWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/\W+/)
		.filter((word) => word.length >= REQUIREMENT_WORD_MIN_LENGTH);
}

/**
 * Whether `query` carries at least one content word (four letters or more)
 * from every hard record-proof requirement's own text — a loose,
 * deterministic stand-in for "the query does not drop a hard requirement",
 * computed alongside `query_quality`'s LLM label rather than asked of the
 * model. Scope: a round span.
 */
export function queryCarriesHardRequirements(
	query: string,
	hardRecordRequirementTexts: readonly string[],
): boolean {
	const lowerQuery = query.toLowerCase();
	return hardRecordRequirementTexts.every((text) =>
		contentWords(text).some((word) => lowerQuery.includes(word)),
	);
}
