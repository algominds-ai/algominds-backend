import type { EngineScore } from "@eval/engine-score";
import type { PeopleVerdict } from "@eval/people-headline";

export type TrialOutput = {
	engine: EngineScore | null;
	companiesRunId: string | null;
	peopleRunId: string | null;
	peopleVerdict: PeopleVerdict | null;
	totalCostDollars: number;
	totalSeconds: number | null;
	skipped: string | null;
};

export type Score = { name: string; score: number | null };

type ScorerInput = { output: TrialOutput };

function engineScoreOf({ output }: ScorerInput): EngineScore | null {
	return output.engine;
}

/** 1 when every full-chain correctness gate held, 0 when any failed, null for a trial the budget skipped before it ran. */
export function gatesPass(input: ScorerInput): Score | null {
	const engine = engineScoreOf(input);
	if (!engine) return null;
	return { name: "gates_pass", score: engine.gatesPass ? 1 : 0 };
}

/** The fraction of `requested` companies that were an accepted company, null for a skipped trial. */
export function companyYield(input: ScorerInput): Score | null {
	const engine = engineScoreOf(input);
	if (!engine) return null;
	return { name: "company_yield", score: engine.companyYield };
}

/** Accepted companies over every company the run stored, null for a skipped trial. */
export function companyPrecision(input: ScorerInput): Score | null {
	const engine = engineScoreOf(input);
	if (!engine) return null;
	return { name: "company_precision", score: engine.companyPrecision };
}

/** Distinct accepted people at accepted companies over every delivered person row, null for a skipped trial. */
export function buyerPrecision(input: ScorerInput): Score | null {
	const engine = engineScoreOf(input);
	if (!engine) return null;
	return { name: "buyer_precision", score: engine.buyerPrecision };
}

/** The fraction of `requested` companies that landed an accepted buyer, null for a skipped trial. */
export function buyerCoverage(input: ScorerInput): Score | null {
	const engine = engineScoreOf(input);
	if (!engine) return null;
	return { name: "buyer_coverage", score: engine.buyerCoverage };
}

/** Buyer coverage times buyer precision, null for a skipped trial. */
export function engineQuality(input: ScorerInput): Score | null {
	const engine = engineScoreOf(input);
	if (!engine) return null;
	return { name: "engine_quality", score: engine.engineQuality };
}

/** Engine quality zeroed out by a failed gate, the one composite rating for the trial, null for a skipped trial. */
export function engineScore(input: ScorerInput): Score | null {
	const engine = engineScoreOf(input);
	if (!engine) return null;
	return { name: "engine_score", score: engine.engineScore };
}

export const CODE_SCORERS = [
	gatesPass,
	companyYield,
	companyPrecision,
	buyerPrecision,
	buyerCoverage,
	engineQuality,
	engineScore,
];
