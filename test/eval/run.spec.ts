import type { SeededTrial } from "@eval/arm-db";
import type { EngineGates, EngineScore } from "@eval/engine-score";
import type { TrialCase } from "@eval/full-chain";
import { budgetBlock, casesFor, newBudget } from "@eval/full-chain";
import {
	MAX_PROFILE_SPEND_DOLLARS,
	MAX_SPEND_DOLLARS,
	MIN_TRIALS,
	PROFILES,
} from "@eval/profiles";
import type { ResultRow } from "@eval/run";
import {
	parseArgs,
	ratingLine,
	runIdsByProfile,
	scoredRowsFrom,
	selectedProfiles,
} from "@eval/run";
import type { TrialOutput } from "@eval/scorers";
import { describe, expect, it } from "vitest";

describe("parseArgs", () => {
	it("defaults to every profile, the baseline arm and the minimum trial count", () => {
		expect(parseArgs([])).toEqual({
			profile: null,
			arm: "baseline",
			trials: MIN_TRIALS,
			count: 3,
			port: 8787,
		});
	});

	it("reads --profile, --arm and --trials as space-separated flag values", () => {
		expect(
			parseArgs(["--profile", "mstone", "--arm", "candidate", "--trials", "3"]),
		).toEqual({
			profile: "mstone",
			arm: "candidate",
			trials: 3,
			count: 3,
			port: 8787,
		});
	});

	it("accepts a single trial", () => {
		expect(parseArgs(["--trials", "1"]).trials).toBe(1);
	});

	it("rejects a trial count below one", () => {
		expect(() => parseArgs(["--trials", "0"])).toThrow(/positive integer/);
	});

	it("rejects a trial count that is not an integer", () => {
		expect(() => parseArgs(["--trials", "abc"])).toThrow(/positive integer/);
	});
});

describe("selectedProfiles", () => {
	it("returns every profile when no slug is given", () => {
		expect(selectedProfiles(null)).toBe(PROFILES);
	});

	it("returns only the named profile", () => {
		expect(selectedProfiles("mstone").map((profile) => profile.slug)).toEqual([
			"mstone",
		]);
	});

	it("throws for an unknown profile slug", () => {
		expect(() => selectedProfiles("nope")).toThrow(/unknown profile/);
	});
});

describe("newBudget", () => {
	it("starts every named profile at zero spend", () => {
		expect(newBudget(["mstone", "aris"])).toEqual({
			spent: 0,
			perProfile: { mstone: 0, aris: 0 },
			profileCap: 2,
		});
	});
});

describe("budgetBlock", () => {
	it("allows a profile under both the total and the per-profile cap", () => {
		const budget = newBudget(["mstone"]);
		expect(budgetBlock(budget, "mstone")).toBeNull();
	});

	it("blocks every profile once total spend reaches the total cap", () => {
		const budget = newBudget(["mstone"]);
		budget.spent = MAX_SPEND_DOLLARS;
		expect(budgetBlock(budget, "mstone")).toMatch(/total spend/);
	});

	it("blocks one profile once its own spend reaches the per-profile cap", () => {
		const budget = newBudget(["mstone", "aris"]);
		budget.perProfile.mstone = MAX_PROFILE_SPEND_DOLLARS;
		expect(budgetBlock(budget, "mstone")).toMatch(/mstone spend/);
		expect(budgetBlock(budget, "aris")).toBeNull();
	});
});

function trial(overrides: Partial<SeededTrial> = {}): SeededTrial {
	return {
		slug: "mstone",
		trialIndex: 0,
		icpId: "icp-1",
		organizationId: "org-1",
		apiKey: "key-1",
		...overrides,
	};
}

function oneCase(overrides: Partial<SeededTrial> = {}): TrialCase {
	const [only] = casesFor([trial(overrides)]);
	if (!only) throw new Error("test setup: casesFor produced no case");
	return only;
}

describe("casesFor", () => {
	it("carries the profile's own bars onto each seeded trial", () => {
		expect(oneCase().bars).toEqual(
			PROFILES.find((profile) => profile.slug === "mstone")?.bars,
		);
	});

	it("throws for a seeded trial naming an unknown profile", () => {
		expect(() => casesFor([trial({ slug: "nope" })])).toThrow(
			/unknown profile/,
		);
	});
});

function output(overrides: Partial<TrialOutput> = {}): TrialOutput {
	return {
		engine: null,
		companiesRunId: null,
		peopleRunId: null,
		peopleVerdict: null,
		totalCostDollars: 0,
		totalSeconds: null,
		skipped: null,
		scoredCompanies: [],
		scoredPeople: [],
		...overrides,
	};
}

function row(
	input: TrialCase,
	outputOverrides: Partial<TrialOutput>,
): ResultRow {
	return {
		input: { slug: input.slug, trialIndex: input.trialIndex, count: 3 },
		output: output(outputOverrides),
	};
}

describe("runIdsByProfile", () => {
	it("groups both run ids by the trial's profile slug", () => {
		const rows = [
			row(oneCase({ slug: "mstone" }), {
				companiesRunId: "company-run-1",
				peopleRunId: "people-run-1",
			}),
			row(oneCase({ slug: "mstone", trialIndex: 1 }), {
				companiesRunId: "company-run-2",
				peopleRunId: "people-run-2",
			}),
			row(oneCase({ slug: "aris" }), {
				companiesRunId: "company-run-3",
				peopleRunId: "people-run-3",
			}),
		];
		expect(runIdsByProfile(rows)).toEqual({
			mstone: [
				"company-run-1",
				"people-run-1",
				"company-run-2",
				"people-run-2",
			],
			aris: ["company-run-3", "people-run-3"],
		});
	});

	it("omits a trial the budget skipped before it ran", () => {
		const rows = [row(oneCase(), { skipped: "budget" })];
		expect(runIdsByProfile(rows)).toEqual({});
	});
});

function passingGates(): EngineGates {
	return {
		noKeyRejectedStored: true,
		noDuplicateOrganisationGroup: true,
		provingPassesWhereRequired: true,
		peopleGatesPass: true,
		bothRunsComplete: true,
		everyStoredCompanyLabelled: true,
		everyDeliveredPersonLabelled: true,
		noRejectedPersonDelivered: true,
		noOverDelivery: true,
		costValidAndUnderBar: true,
		secondsValidAndUnderBar: true,
	};
}

function scoredEngine(engineScore: number): EngineScore {
	return {
		acceptedCompanies: 1,
		acceptedCompaniesWithBuyer: 1,
		acceptedPeople: 1,
		deliveredPeopleCount: 1,
		gates: passingGates(),
		gatesPass: true,
		companyYield: engineScore,
		companyPrecision: 1,
		buyerPrecision: 1,
		buyerCoverage: engineScore,
		engineQuality: engineScore,
		engineScore,
		acceptedPerDollar: 1,
		acceptedPerMinute: 1,
	};
}

describe("ratingLine", () => {
	it("reports ten times the mean engine score when every profile is fully scored", () => {
		const rows = [
			row(oneCase({ slug: "mstone" }), { engine: scoredEngine(0.5) }),
			row(oneCase({ slug: "aris" }), { engine: scoredEngine(1) }),
		];
		expect(ratingLine(rows, [{ slug: "mstone" }, { slug: "aris" }])).toBe(
			"rating 7.50",
		);
	});

	it("reports incomplete the moment one selected profile has a skipped trial", () => {
		const rows = [
			row(oneCase({ slug: "mstone" }), { engine: scoredEngine(1) }),
			row(oneCase({ slug: "aris" }), { skipped: "budget" }),
		];
		expect(ratingLine(rows, [{ slug: "mstone" }, { slug: "aris" }])).toBe(
			"rating incomplete (1 of 2 profiles)",
		);
	});

	it("reports incomplete when a selected profile has no rows at all", () => {
		const rows = [
			row(oneCase({ slug: "mstone" }), { engine: scoredEngine(1) }),
		];
		expect(ratingLine(rows, [{ slug: "mstone" }, { slug: "aris" }])).toBe(
			"rating incomplete (1 of 2 profiles)",
		);
	});
});

describe("scoredRowsFrom", () => {
	it("carries each row's slug, trial index and scored companies and people", () => {
		const rows = [
			row(oneCase({ slug: "mstone" }), {
				scoredCompanies: [{ domain: "a.com", label: "accept" }],
				scoredPeople: [
					{
						linkedinUrl: "https://linkedin.com/in/a",
						company: "a.com",
						label: "accept",
					},
				],
			}),
		];
		expect(scoredRowsFrom(rows)).toEqual([
			{
				slug: "mstone",
				trialIndex: 0,
				companies: [{ domain: "a.com", label: "accept" }],
				people: [
					{
						linkedinUrl: "https://linkedin.com/in/a",
						company: "a.com",
						label: "accept",
					},
				],
			},
		]);
	});
});
