import type { EngineScoreInput } from "@eval/engine-score";
import { computeEngineScore } from "@eval/engine-score";
import type { StoredCompanyRecord } from "@eval/headline";
import { emptyKeyFile } from "@eval/label-core";
import type { StoredPersonRecord } from "@eval/people-headline";
import { emptyPeopleKeyFile } from "@eval/people-key";
import type { ProfileBars } from "@eval/profiles";
import { describe, expect, it } from "vitest";

const BARS: ProfileBars = { maxCostDollars: 2, maxSeconds: 200 };

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
		linkedinUrl: "https://linkedin.com/in/a",
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
	peopleKey.people["https://linkedin.com/in/a"] = {
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
		storedCompanies: [company()],
		deliveredPeople: [person()],
		requested: 3,
		totalCostDollars: 1,
		totalSeconds: 60,
		bars: BARS,
		...overrides,
	};
}

describe("computeEngineScore", () => {
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

	it("reports zero company precision when the run stored no company at all", () => {
		const score = computeEngineScore(
			input({ storedCompanies: [], deliveredPeople: [] }),
		);
		expect(score.companyPrecision).toBe(0);
		expect(score.companyYield).toBe(0);
	});
});
