import type { StoredCompanyRecord } from "@eval/headline";
import type { KeyFile } from "@eval/label-core";
import type { StoredPersonRecord } from "@eval/people-headline";
import type { PeopleKeyFile } from "@eval/people-key";
import type { ProfileBars } from "@eval/profiles";

export type EngineScoreCompanyGates = {
	noKeyRejectedStored: boolean;
	noDuplicateOrganisationGroup: boolean;
	provingPassesWhereRequired: boolean;
};

export type EngineScoreInput = {
	key: KeyFile;
	peopleKey: PeopleKeyFile;
	companyGates: EngineScoreCompanyGates;
	storedCompanies: readonly StoredCompanyRecord[];
	deliveredPeople: readonly StoredPersonRecord[];
	requested: number;
	totalCostDollars: number;
	totalSeconds: number | null;
	bars: ProfileBars;
};

export type EngineScore = {
	acceptedCompanies: number;
	acceptedCompaniesWithBuyer: number;
	acceptedPeople: number;
	deliveredPeopleCount: number;
	gatesPass: boolean;
	companyYield: number;
	companyPrecision: number;
	buyerPrecision: number;
	buyerCoverage: number;
	engineQuality: number;
	engineScore: number;
	acceptedPerDollar: number;
	acceptedPerMinute: number;
};

function safeDivide(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function acceptedCompanyDomains(
	key: KeyFile,
	stored: readonly StoredCompanyRecord[],
): Set<string> {
	return new Set(
		stored
			.filter((row) => key.companies[row.domain]?.label === "accept")
			.map((row) => row.domain),
	);
}

function personLabel(
	peopleKey: PeopleKeyFile,
	person: StoredPersonRecord,
): string | null {
	if (person.linkedinUrl === null) return null;
	return peopleKey.people[person.linkedinUrl]?.label ?? null;
}

function acceptedPeopleAtAcceptedCompanies(
	acceptedDomains: ReadonlySet<string>,
	peopleKey: PeopleKeyFile,
	people: readonly StoredPersonRecord[],
): StoredPersonRecord[] {
	return people.filter(
		(person) =>
			acceptedDomains.has(person.company) &&
			personLabel(peopleKey, person) === "accept",
	);
}

function everyStoredCompanyLabelled(
	key: KeyFile,
	stored: readonly StoredCompanyRecord[],
): boolean {
	return stored.every((row) => key.companies[row.domain]?.label != null);
}

function everyDeliveredPersonLabelled(
	peopleKey: PeopleKeyFile,
	people: readonly StoredPersonRecord[],
): boolean {
	return people.every((person) => personLabel(peopleKey, person) !== null);
}

function gatesHold(input: EngineScoreInput): boolean {
	const seconds = input.totalSeconds;
	return (
		input.companyGates.noKeyRejectedStored &&
		input.companyGates.noDuplicateOrganisationGroup &&
		input.companyGates.provingPassesWhereRequired &&
		everyStoredCompanyLabelled(input.key, input.storedCompanies) &&
		everyDeliveredPersonLabelled(input.peopleKey, input.deliveredPeople) &&
		input.totalCostDollars <= input.bars.maxCostDollars &&
		(seconds === null || seconds <= input.bars.maxSeconds)
	);
}

/**
 * The one composite score for a full-chain trial: correctness gates across
 * both the companies and the people run, then how much of what was
 * requested came back as an accepted company with an accepted buyer at it,
 * and how clean the delivered people were. `engineScore` is `0` whenever a
 * gate fails, whatever the underlying yield and precision were.
 */
export function computeEngineScore(input: EngineScoreInput): EngineScore {
	const acceptedDomains = acceptedCompanyDomains(
		input.key,
		input.storedCompanies,
	);
	const acceptedPeople = acceptedPeopleAtAcceptedCompanies(
		acceptedDomains,
		input.peopleKey,
		input.deliveredPeople,
	);
	const acceptedCompanies = acceptedDomains.size;
	const acceptedCompaniesWithBuyer = new Set(
		acceptedPeople.map((person) => person.company),
	).size;
	const acceptedPeopleCount = new Set(
		acceptedPeople.map((person) => person.linkedinUrl),
	).size;
	const deliveredPeopleCount = input.deliveredPeople.length;
	const gatesPass = gatesHold(input);
	const buyerPrecision = safeDivide(acceptedPeopleCount, deliveredPeopleCount);
	const buyerCoverage = safeDivide(acceptedCompaniesWithBuyer, input.requested);
	const engineQuality = buyerCoverage * buyerPrecision;
	const totalMinutes =
		input.totalSeconds === null ? 0 : input.totalSeconds / 60;
	return {
		acceptedCompanies,
		acceptedCompaniesWithBuyer,
		acceptedPeople: acceptedPeopleCount,
		deliveredPeopleCount,
		gatesPass,
		companyYield: safeDivide(acceptedCompanies, input.requested),
		companyPrecision: safeDivide(
			acceptedCompanies,
			input.storedCompanies.length,
		),
		buyerPrecision,
		buyerCoverage,
		engineQuality,
		engineScore: (gatesPass ? 1 : 0) * engineQuality,
		acceptedPerDollar: safeDivide(
			acceptedCompanies + acceptedPeopleCount,
			input.totalCostDollars,
		),
		acceptedPerMinute: safeDivide(
			acceptedCompanies + acceptedPeopleCount,
			totalMinutes,
		),
	};
}
