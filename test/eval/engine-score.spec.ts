import type { EngineScoreInput } from "@eval/engine-score";
import { computeEngineScore } from "@eval/engine-score";
import type { StoredCompanyRecord } from "@eval/headline";
import { emptyKeyFile } from "@eval/label-core";
import type { StoredPersonRecord } from "@eval/people-headline";
import { emptyPeopleKeyFile } from "@eval/people-key";
import type { ProfileBars } from "@eval/profiles";
import { describe, expect, it } from "vitest";

const BARS: ProfileBars = { maxCostDollars: 2, maxSeconds: 200 };
const PERSON_URL = "https://linkedin.com/in/a";

function company(
	overrides: Partial<StoredCompanyRecord> = {},
): StoredCompanyRecord {
	return {
		domain: "a.com",
		name: "A Inc",
		citedPage: null,
		quote: null,
		evidenceCheck: null,
		provingPageStored: false,
		...overrides,
	};
}

function person(
	overrides: Partial<StoredPersonRecord> = {},
): StoredPersonRecord {
	return {
		linkedinUrl: PERSON_URL,
		name: "Jane Doe",
		title: "VP Sales",
		company: "a.com",
		location: null,
		...overrides,
	};
}

function input(overrides: Partial<EngineScoreInput> = {}): EngineScoreInput {
	const key = emptyKeyFile("mstone", "icp-1");
	key.companies["a.com"] = {
		label: "accept",
		name: "A Inc",
		firstSeenRunId: "run-0",
		lastSeenAt: "t",
	};
	const peopleKey = emptyPeopleKeyFile("mstone", "icp-1");
	peopleKey.people[PERSON_URL] = {
		label: "accept",
		name: "Jane Doe",
		title: "VP Sales",
		company: "a.com",
		location: null,
		firstSeenRunId: "run-0",
	};
	return {
		key,
		peopleKey,
		companyGates: {
			noKeyRejectedStored: true,
			noDuplicateOrganisationGroup: true,
			provingPassesWhereRequired: true,
		},
		companiesStatus: "complete",
		peopleStatus: "complete",
		peopleGatesPass: true,
		storedCompanies: [company()],
		deliveredPeople: [person()],
		requested: 3,
		totalCostDollars: 1,
		totalSeconds: 60,
		bars: BARS,
		...overrides,
	};
}

function withBasePersonEntry(
	built: EngineScoreInput,
	overrides: Partial<EngineScoreInput["peopleKey"]["people"][string]>,
): EngineScoreInput {
	const entry = built.peopleKey.people[PERSON_URL];
	if (!entry) throw new Error("test setup: no key entry for the base person");
	built.peopleKey.people[PERSON_URL] = { ...entry, ...overrides };
	return built;
}

describe("computeEngineScore coverage", () => {
	it("reports zero buyer coverage and zero engine quality when the run delivered no people", () => {
		const score = computeEngineScore(input({ deliveredPeople: [] }));
		expect(score.buyerCoverage).toBe(0);
		expect(score.buyerPrecision).toBe(0);
		expect(score.engineQuality).toBe(0);
		expect(score.engineScore).toBe(0);
	});

	it("fails the gate when one delivered person carries no label", () => {
		const built = input();
		built.deliveredPeople = [
			person(),
			person({ linkedinUrl: "https://linkedin.com/in/b" }),
		];
		const score = computeEngineScore(built);
		expect(score.gatesPass).toBe(false);
		expect(score.engineScore).toBe(0);
	});

	it("counts an accepted company once even with two accepted people there", () => {
		const built = input();
		built.peopleKey.people["https://linkedin.com/in/b"] = {
			label: "accept",
			name: "John Roe",
			title: "CRO",
			company: "a.com",
			location: null,
			firstSeenRunId: "run-0",
		};
		built.deliveredPeople = [
			person(),
			person({ linkedinUrl: "https://linkedin.com/in/b", name: "John Roe" }),
		];
		const score = computeEngineScore(built);
		expect(score.acceptedCompaniesWithBuyer).toBe(1);
		expect(score.acceptedPeople).toBe(2);
		expect(score.buyerCoverage).toBe(1 / 3);
	});
});

describe("computeEngineScore employer binding", () => {
	it("does not accept a person whose key entry names a different employer", () => {
		const built = withBasePersonEntry(input(), { company: "old-employer.com" });
		const score = computeEngineScore(built);
		expect(score.acceptedPeople).toBe(0);
		expect(score.buyerCoverage).toBe(0);
	});
});

describe("computeEngineScore reject labels", () => {
	it("fails the gate when a delivered person is labelled reject:wrong-employer", () => {
		const built = withBasePersonEntry(input(), {
			label: "reject:wrong-employer",
		});
		expect(computeEngineScore(built).gatesPass).toBe(false);
	});

	it("fails the gate when a delivered person is labelled reject:duplicate", () => {
		const built = withBasePersonEntry(input(), { label: "reject:duplicate" });
		expect(computeEngineScore(built).gatesPass).toBe(false);
	});

	it("fails the gate when a delivered person is labelled reject:left-company", () => {
		const built = withBasePersonEntry(input(), {
			label: "reject:left-company",
		});
		expect(computeEngineScore(built).gatesPass).toBe(false);
	});
});

describe("computeEngineScore run and gate accounting", () => {
	it("folds the people verdict's own gates into gatesPass", () => {
		const built = input({ peopleGatesPass: false });
		expect(computeEngineScore(built).gatesPass).toBe(false);
	});

	it("passes when the people stage never ran, since there was nothing for it to fail", () => {
		const built = input({ peopleStatus: null, peopleGatesPass: null });
		expect(computeEngineScore(built).gatesPass).toBe(true);
	});

	it("fails the gate when the companies run did not finish complete", () => {
		expect(
			computeEngineScore(input({ companiesStatus: "errored" })).gatesPass,
		).toBe(false);
	});

	it("fails the gate when the people run did not finish complete", () => {
		expect(
			computeEngineScore(input({ peopleStatus: "errored" })).gatesPass,
		).toBe(false);
	});
});

describe("computeEngineScore bounded scores", () => {
	it("counts a same-as alias of an accepted company as that company once", () => {
		const built = withBasePersonEntry(input(), { company: "b.com" });
		built.key.companies["b.com"] = {
			label: "same-as:a.com",
			name: null,
			firstSeenRunId: "run-0",
			lastSeenAt: "t",
		};
		built.storedCompanies = [company({ domain: "b.com" })];
		built.deliveredPeople = [person({ company: "b.com" })];
		const score = computeEngineScore(built);
		expect(score.acceptedCompanies).toBe(1);
	});

	it("fails the gate and never exceeds one on over-delivery beyond requested", () => {
		const built = input({ requested: 1 });
		built.storedCompanies = [company(), company({ domain: "b.com" })];
		built.key.companies["b.com"] = {
			label: "accept",
			name: "B Inc",
			firstSeenRunId: "run-0",
			lastSeenAt: "t",
		};
		const score = computeEngineScore(built);
		expect(score.gatesPass).toBe(false);
		expect(score.companyYield).toBeLessThanOrEqual(1);
	});

	it("clamps every ratio score into [0, 1]", () => {
		const score = computeEngineScore(input({ requested: 1 }));
		for (const value of [
			score.companyYield,
			score.companyPrecision,
			score.buyerPrecision,
			score.buyerCoverage,
			score.engineQuality,
			score.engineScore,
		]) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(1);
		}
	});
});

describe("computeEngineScore accounting validity", () => {
	it("fails the gate and zeroes the score on a NaN cost", () => {
		const score = computeEngineScore(input({ totalCostDollars: Number.NaN }));
		expect(score.gatesPass).toBe(false);
		expect(score.engineScore).toBe(0);
	});

	it("fails the gate and zeroes the score on a negative cost", () => {
		const score = computeEngineScore(input({ totalCostDollars: -1 }));
		expect(score.gatesPass).toBe(false);
		expect(score.engineScore).toBe(0);
	});

	it("fails the gate on a negative seconds figure", () => {
		expect(computeEngineScore(input({ totalSeconds: -1 })).gatesPass).toBe(
			false,
		);
	});

	it("fails costUnderBar and secondsUnderBar past the combined bars", () => {
		const overBudget = computeEngineScore(input({ totalCostDollars: 5 }));
		expect(overBudget.gatesPass).toBe(false);
		const overTime = computeEngineScore(input({ totalSeconds: 500 }));
		expect(overTime.gatesPass).toBe(false);
	});

	it("reports zero rates rather than dividing by zero cost or zero minutes", () => {
		const score = computeEngineScore(
			input({ totalCostDollars: 0, totalSeconds: 0 }),
		);
		expect(score.acceptedPerDollar).toBe(0);
		expect(score.acceptedPerMinute).toBe(0);
	});
});

describe("computeEngineScore rates and precision", () => {
	it("reports full yield, coverage and precision for a clean trial under bars", () => {
		const score = computeEngineScore(input());
		expect(score.gatesPass).toBe(true);
		expect(score.companyYield).toBe(1 / 3);
		expect(score.companyPrecision).toBe(1);
		expect(score.buyerPrecision).toBe(1);
		expect(score.buyerCoverage).toBe(1 / 3);
		expect(score.engineScore).toBeCloseTo(1 / 3);
	});

	it("does not count an accepted person at a company the key never accepted", () => {
		const built = input();
		built.storedCompanies = [company(), company({ domain: "b.com" })];
		built.key.companies["b.com"] = {
			label: "reject:not-a-company",
			name: "B Inc",
			firstSeenRunId: "run-0",
			lastSeenAt: "t",
		};
		built.peopleKey.people["https://linkedin.com/in/c"] = {
			label: "accept",
			name: "Someone",
			title: "CFO",
			company: "b.com",
			location: null,
			firstSeenRunId: "run-0",
		};
		built.deliveredPeople = [
			person(),
			person({ linkedinUrl: "https://linkedin.com/in/c", company: "b.com" }),
		];
		const score = computeEngineScore(built);
		expect(score.acceptedPeople).toBe(1);
		expect(score.acceptedCompaniesWithBuyer).toBe(1);
	});

	it("fails a company gate the companies run itself already failed", () => {
		const built = input();
		built.companyGates.noKeyRejectedStored = false;
		expect(computeEngineScore(built).gatesPass).toBe(false);
	});

	it("reports zero company precision when the run stored no company at all", () => {
		const score = computeEngineScore(
			input({ storedCompanies: [], deliveredPeople: [] }),
		);
		expect(score.companyPrecision).toBe(0);
		expect(score.companyYield).toBe(0);
	});
});
