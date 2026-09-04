import type {
	PeopleBars,
	PeopleRunReport,
	PeopleVerdictInput,
	StoredPersonRecord,
	StoredRunCompany,
} from "@eval/people-headline";
import {
	comparePeopleVerdicts,
	computePeopleVerdict,
} from "@eval/people-headline";
import type { PersonKeyEntry, StoredPerson } from "@eval/people-key";
import { emptyPeopleKeyFile, mergeStoredPeople } from "@eval/people-key";
import { describe, expect, it } from "vitest";

const BARS: PeopleBars = { maxCostDollars: 2, countries: ["United States"] };
const URL = "https://linkedin.com/in/a";
const BASE = {
	name: "Jane Doe",
	title: "VP Sales",
	company: "a.com",
	location: "New York, United States",
};

function run(overrides: Partial<PeopleRunReport> = {}): PeopleRunReport {
	return { runId: "run-1", status: "complete", costDollars: 1, ...overrides };
}

function person(
	overrides: Partial<StoredPersonRecord> = {},
): StoredPersonRecord {
	return { linkedinUrl: URL, ...BASE, ...overrides };
}

function stored(overrides: Partial<StoredPerson> = {}): StoredPerson {
	return { linkedinUrl: URL, runId: "run-0", ...BASE, ...overrides };
}

function keyEntry(
	label: string | null,
	overrides: Partial<PersonKeyEntry> = {},
): PersonKeyEntry {
	return { label, firstSeenRunId: "run-0", ...BASE, ...overrides };
}

function input(
	overrides: Partial<PeopleVerdictInput> = {},
): PeopleVerdictInput {
	const key = emptyPeopleKeyFile("mstone", "icp-1");
	key.people[URL] = keyEntry("accept");
	const companies: StoredRunCompany[] = [
		{ domain: "a.com", peopleVerified: 1 },
	];
	return {
		key,
		run: run(),
		bars: BARS,
		companies,
		people: [person()],
		...overrides,
	};
}

describe("mergeStoredPeople", () => {
	it("adds an unlabelled entry for a new linkedin url", () => {
		const key = emptyPeopleKeyFile("mstone", "icp-1");
		const merged = mergeStoredPeople(key, [stored()]);
		expect(merged.people[URL]?.label).toBeNull();
	});
	it("never overwrites an existing label", () => {
		const key = emptyPeopleKeyFile("mstone", "icp-1");
		key.people[URL] = keyEntry("reject:not-buyer");
		const merged = mergeStoredPeople(key, [stored({ name: "Someone Else" })]);
		const entry = merged.people[URL];
		expect(entry?.label).toBe("reject:not-buyer");
		expect(entry?.name).toBe("Jane Doe");
	});
});

describe("computePeopleVerdict", () => {
	it("fails inCountry when a stored person's location names no bar country", () => {
		const built = input();
		built.people = [person({ location: "Berlin, Germany" })];
		const verdict = computePeopleVerdict(built);
		expect(verdict.gates.inCountry).toBe(false);
		expect(verdict.allGatesPass).toBe(false);
	});

	it("passes inCountry for a person with no recorded location", () => {
		const built = input();
		built.people = [person({ location: null })];
		expect(computePeopleVerdict(built).gates.inCountry).toBe(true);
	});
});

describe("comparePeopleVerdicts", () => {
	it("ranks every gate passing above any gate failing", () => {
		const clean = computePeopleVerdict(input());
		const dirty = computePeopleVerdict(
			input({ people: [person({ location: "Berlin, Germany" })] }),
		);
		expect(comparePeopleVerdicts(clean, dirty)).toBeLessThan(0);
	});

	it("breaks a tie on gates by higher verified people per company, then lower cost per verified person", () => {
		const better = computePeopleVerdict(
			input({ companies: [{ domain: "a.com", peopleVerified: 2 }] }),
		);
		const worse = computePeopleVerdict(input());
		expect(comparePeopleVerdicts(better, worse)).toBeLessThan(0);

		const cheaper = computePeopleVerdict(
			input({ run: run({ costDollars: 0.5 }) }),
		);
		const pricier = computePeopleVerdict(
			input({ run: run({ costDollars: 1.5 }) }),
		);
		expect(comparePeopleVerdicts(cheaper, pricier)).toBeLessThan(0);
	});
});
