import type { StoredCompanyRecord } from "@eval/headline";
import { canonicalDomain } from "@eval/headline";
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
	companiesStatus: string;
	peopleStatus: string | null;
	peopleGatesPass: boolean | null;
	storedCompanies: readonly StoredCompanyRecord[];
	deliveredPeople: readonly StoredPersonRecord[];
	requested: number;
	totalCostDollars: number;
	totalSeconds: number | null;
	bars: ProfileBars;
};

export type EngineGates = {
	noKeyRejectedStored: boolean;
	noDuplicateOrganisationGroup: boolean;
	provingPassesWhereRequired: boolean;
	peopleGatesPass: boolean;
	bothRunsComplete: boolean;
	everyStoredCompanyLabelled: boolean;
	everyDeliveredPersonLabelled: boolean;
	noRejectedPersonDelivered: boolean;
	noOverDelivery: boolean;
	costValidAndUnderBar: boolean;
	secondsValidAndUnderBar: boolean;
};

export type EngineScore = {
	acceptedCompanies: number;
	acceptedCompaniesWithBuyer: number;
	acceptedPeople: number;
	deliveredPeopleCount: number;
	gates: EngineGates;
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

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function safeDivide(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function isValidCost(cost: number): boolean {
	return Number.isFinite(cost) && cost >= 0;
}

function isValidSeconds(seconds: number | null): boolean {
	return seconds === null || (Number.isFinite(seconds) && seconds >= 0);
}

function acceptedCompanyDomains(
	key: KeyFile,
	stored: readonly StoredCompanyRecord[],
): Set<string> {
	const canonicalIds = stored.map((row) => canonicalDomain(key, row.domain));
	return new Set(
		canonicalIds.filter((domain) => key.companies[domain]?.label === "accept"),
	);
}

function personLabel(
	peopleKey: PeopleKeyFile,
	person: StoredPersonRecord,
): string | null {
	if (person.linkedinUrl === null) return null;
	return peopleKey.people[person.linkedinUrl]?.label ?? null;
}

function personMatchesDeliveredEmployer(
	peopleKey: PeopleKeyFile,
	person: StoredPersonRecord,
): boolean {
	if (person.linkedinUrl === null) return false;
	const entry = peopleKey.people[person.linkedinUrl];
	return entry !== undefined && entry.company === person.company;
}

function isAcceptedAtAcceptedCompany(
	acceptedDomains: ReadonlySet<string>,
	keys: { key: KeyFile; peopleKey: PeopleKeyFile },
	person: StoredPersonRecord,
): boolean {
	return (
		acceptedDomains.has(canonicalDomain(keys.key, person.company)) &&
		personLabel(keys.peopleKey, person) === "accept" &&
		personMatchesDeliveredEmployer(keys.peopleKey, person)
	);
}

function anyPersonRejected(
	peopleKey: PeopleKeyFile,
	people: readonly StoredPersonRecord[],
): boolean {
	return people.some((person) => {
		const label = personLabel(peopleKey, person);
		return label?.startsWith("reject:") ?? false;
	});
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

/**
 * Every gate the full chain must clear: the companies gates it already
 * carried, the people run's own gates, both runs actually completing, every
 * delivered row labelled with no rejects among the people, no more stored
 * companies than were requested, and valid, in-bar cost and seconds.
 */
function computeGates(input: EngineScoreInput): EngineGates {
	const seconds = input.totalSeconds;
	return {
		noKeyRejectedStored: input.companyGates.noKeyRejectedStored,
		noDuplicateOrganisationGroup:
			input.companyGates.noDuplicateOrganisationGroup,
		provingPassesWhereRequired: input.companyGates.provingPassesWhereRequired,
		peopleGatesPass: input.peopleGatesPass === null || input.peopleGatesPass,
		bothRunsComplete:
			input.companiesStatus === "complete" &&
			(input.peopleStatus === null || input.peopleStatus === "complete"),
		everyStoredCompanyLabelled: everyStoredCompanyLabelled(
			input.key,
			input.storedCompanies,
		),
		everyDeliveredPersonLabelled: everyDeliveredPersonLabelled(
			input.peopleKey,
			input.deliveredPeople,
		),
		noRejectedPersonDelivered: !anyPersonRejected(
			input.peopleKey,
			input.deliveredPeople,
		),
		noOverDelivery: input.storedCompanies.length <= input.requested,
		costValidAndUnderBar:
			isValidCost(input.totalCostDollars) &&
			input.totalCostDollars <= input.bars.maxCostDollars,
		secondsValidAndUnderBar:
			isValidSeconds(seconds) &&
			(seconds === null || seconds <= input.bars.maxSeconds),
	};
}

/**
 * The one composite score for a full-chain trial: every gate above, then
 * how much of what was requested came back as an accepted company with an
 * accepted buyer bound to it, and how clean the delivered people were.
 * `engineScore` is `0` whenever a gate fails, whatever the underlying yield
 * and precision were, and every ratio is clamped to `[0, 1]`.
 */
export function computeEngineScore(input: EngineScoreInput): EngineScore {
	const acceptedDomains = acceptedCompanyDomains(
		input.key,
		input.storedCompanies,
	);
	const keys = { key: input.key, peopleKey: input.peopleKey };
	const acceptedPeople = input.deliveredPeople.filter((person) =>
		isAcceptedAtAcceptedCompany(acceptedDomains, keys, person),
	);
	const acceptedCompanies = acceptedDomains.size;
	const acceptedCompaniesWithBuyer = new Set(
		acceptedPeople.map((person) => canonicalDomain(input.key, person.company)),
	).size;
	const acceptedPeopleCount = new Set(
		acceptedPeople.map((person) => person.linkedinUrl),
	).size;
	const deliveredPeopleCount = input.deliveredPeople.length;
	const gates = computeGates(input);
	const gatesPass = Object.values(gates).every(Boolean);
	const buyerPrecision = clamp01(
		safeDivide(acceptedPeopleCount, deliveredPeopleCount),
	);
	const buyerCoverage = clamp01(
		safeDivide(acceptedCompaniesWithBuyer, input.requested),
	);
	const engineQuality = clamp01(buyerCoverage * buyerPrecision);
	const totalMinutes =
		input.totalSeconds === null ? 0 : input.totalSeconds / 60;
	const acceptedPerDollar = isValidCost(input.totalCostDollars)
		? safeDivide(
				acceptedCompanies + acceptedPeopleCount,
				input.totalCostDollars,
			)
		: 0;
	const acceptedPerMinute =
		isValidSeconds(input.totalSeconds) && totalMinutes > 0
			? safeDivide(acceptedCompanies + acceptedPeopleCount, totalMinutes)
			: 0;
	return {
		acceptedCompanies,
		acceptedCompaniesWithBuyer,
		acceptedPeople: acceptedPeopleCount,
		deliveredPeopleCount,
		gates,
		gatesPass,
		companyYield: clamp01(safeDivide(acceptedCompanies, input.requested)),
		companyPrecision: clamp01(
			safeDivide(acceptedCompanies, input.storedCompanies.length),
		),
		buyerPrecision,
		buyerCoverage,
		engineQuality,
		engineScore: clamp01((gatesPass ? 1 : 0) * engineQuality),
		acceptedPerDollar,
		acceptedPerMinute,
	};
}
