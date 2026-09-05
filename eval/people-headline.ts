import type { PeopleKeyFile } from "@eval/people-key";

export type PeopleRunReport = {
	runId: string;
	status: string;
	costDollars: number;
};

export type StoredRunCompany = {
	domain: string;
	peopleVerified: number;
};

export type StoredPersonRecord = {
	linkedinUrl: string | null;
	name: string | null;
	title: string | null;
	company: string;
	location: string | null;
};

export type PeopleBars = {
	maxCostDollars: number;
	countries: readonly string[];
};

export type PeopleGates = {
	runCompleted: boolean;
	noKeyRejectedStored: boolean;
	everyoneReachable: boolean;
	inCountry: boolean;
	costUnderBar: boolean;
};

export type PeopleVerdict = {
	runId: string;
	gates: PeopleGates;
	allGatesPass: boolean;
	verifiedPerCompany: number;
	precision: number | null;
	costPerVerifiedPerson: number | null;
	unlabelledCount: number;
};

function keyLabelFor(
	key: PeopleKeyFile,
	linkedinUrl: string | null,
): string | null {
	if (linkedinUrl === null) return null;
	return key.people[linkedinUrl]?.label ?? null;
}

function noKeyRejectedStored(
	key: PeopleKeyFile,
	people: readonly StoredPersonRecord[],
): boolean {
	return people.every(
		(row) => !keyLabelFor(key, row.linkedinUrl)?.startsWith("reject:"),
	);
}

function everyoneReachable(people: readonly StoredPersonRecord[]): boolean {
	return people.every(
		(row) => row.linkedinUrl !== null && row.linkedinUrl.length > 0,
	);
}

function locationInCountries(
	location: string | null,
	countries: readonly string[],
): boolean {
	if (location === null) return true;
	const lowered = location.toLowerCase();
	return countries.some((country) => lowered.includes(country.toLowerCase()));
}

function inCountry(
	people: readonly StoredPersonRecord[],
	countries: readonly string[],
): boolean {
	return people.every((row) => locationInCountries(row.location, countries));
}

function totalVerified(companies: readonly StoredRunCompany[]): number {
	return companies.reduce((total, row) => total + row.peopleVerified, 0);
}

function perVerified(total: number, verified: number): number | null {
	return verified === 0 ? null : total / verified;
}

export type PeopleVerdictInput = {
	key: PeopleKeyFile;
	run: PeopleRunReport;
	companies: readonly StoredRunCompany[];
	people: readonly StoredPersonRecord[];
	bars: PeopleBars;
};

/**
 * The lexicographic verdict for one people run: correctness gates first,
 * then more verified people per company, then lower cost per verified
 * person. Precision, accept over labelled stored people, is reported as a
 * score but never ranks, because a stored reject already fails a gate.
 */
export function computePeopleVerdict(input: PeopleVerdictInput): PeopleVerdict {
	const { key, run, companies, people, bars } = input;
	const verified = totalVerified(companies);
	const gates: PeopleGates = {
		runCompleted: run.status === "complete",
		noKeyRejectedStored: noKeyRejectedStored(key, people),
		everyoneReachable: everyoneReachable(people),
		inCountry: inCountry(people, bars.countries),
		costUnderBar: run.costDollars <= bars.maxCostDollars,
	};
	const labels = people.map((row) => keyLabelFor(key, row.linkedinUrl));
	const acceptedStored = labels.filter((label) => label === "accept").length;
	const labelledStored = labels.filter((label) => label !== null).length;
	return {
		runId: run.runId,
		gates,
		allGatesPass: Object.values(gates).every(Boolean),
		verifiedPerCompany:
			companies.length === 0 ? 0 : verified / companies.length,
		precision: labelledStored === 0 ? null : acceptedStored / labelledStored,
		costPerVerifiedPerson: perVerified(run.costDollars, verified),
		unlabelledCount: labels.filter((label) => label === null).length,
	};
}

function rank(value: number | null): number {
	return value === null ? Number.POSITIVE_INFINITY : value;
}

/**
 * Negative when `a` is the better run, positive when `b` is, zero when the
 * lexicographic order cannot separate them: gates, then more verified
 * people per company, then lower cost per verified person.
 */
export function comparePeopleVerdicts(
	a: PeopleVerdict,
	b: PeopleVerdict,
): number {
	if (a.allGatesPass !== b.allGatesPass) return a.allGatesPass ? -1 : 1;
	if (a.verifiedPerCompany !== b.verifiedPerCompany) {
		return b.verifiedPerCompany - a.verifiedPerCompany;
	}
	return rank(a.costPerVerifiedPerson) - rank(b.costPerVerifiedPerson);
}
