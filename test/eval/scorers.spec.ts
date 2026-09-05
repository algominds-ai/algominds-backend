import type { EngineScore } from "@eval/engine-score";
import type { TrialOutput } from "@eval/scorers";
import {
	buyerCoverage,
	buyerPrecision,
	companyPrecision,
	companyYield,
	engineQuality,
	engineScore,
	gatesPass,
} from "@eval/scorers";
import { describe, expect, it } from "vitest";

function engine(overrides: Partial<EngineScore> = {}): EngineScore {
	return {
		acceptedCompanies: 1,
		acceptedCompaniesWithBuyer: 1,
		acceptedPeople: 1,
		deliveredPeopleCount: 1,
		gatesPass: true,
		companyYield: 1 / 3,
		companyPrecision: 1,
		buyerPrecision: 1,
		buyerCoverage: 1 / 3,
		engineQuality: 1 / 3,
		engineScore: 1 / 3,
		acceptedPerDollar: 2,
		acceptedPerMinute: 1,
		...overrides,
	};
}

function output(overrides: Partial<TrialOutput> = {}): TrialOutput {
	return {
		engine: engine(),
		companiesRunId: "run-1",
		peopleRunId: "run-2",
		peopleVerdict: null,
		totalCostDollars: 1,
		totalSeconds: 60,
		skipped: null,
		...overrides,
	};
}

const SCORERS: readonly [
	string,
	typeof gatesPass,
	(engine: EngineScore) => number,
][] = [
	["gates_pass", gatesPass, (engine) => (engine.gatesPass ? 1 : 0)],
	["company_yield", companyYield, (engine) => engine.companyYield],
	["company_precision", companyPrecision, (engine) => engine.companyPrecision],
	["buyer_precision", buyerPrecision, (engine) => engine.buyerPrecision],
	["buyer_coverage", buyerCoverage, (engine) => engine.buyerCoverage],
	["engine_quality", engineQuality, (engine) => engine.engineQuality],
	["engine_score", engineScore, (engine) => engine.engineScore],
];

describe.each(SCORERS)("%s scorer", (name, scorer, expected) => {
	it(`reports the engine's own ${name}`, () => {
		const built = engine();
		expect(scorer({ output: output({ engine: built }) })).toEqual({
			name,
			score: expected(built),
		});
	});

	it("is null for a trial the budget skipped", () => {
		expect(scorer({ output: output({ engine: null }) })).toBeNull();
	});
});

describe("gatesPass", () => {
	it("scores 0 when the engine's gate failed", () => {
		expect(
			gatesPass({ output: output({ engine: engine({ gatesPass: false }) }) }),
		).toEqual({ name: "gates_pass", score: 0 });
	});
});
