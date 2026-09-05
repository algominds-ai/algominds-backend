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
		domain: "commsec.com.au",
		name: null,
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
		company: "commsec.com.au",
		location: null,
		...overrides,
	};
}

function input(overrides: Partial<EngineScoreInput> = {}): EngineScoreInput {
	const key = emptyKeyFile("mstone", "icp-1");
	key.companies["commbank.com.au"] = {
		label: "accept",
		name: "Commonwealth Bank",
		firstSeenRunId: "run-0",
		lastSeenAt: "t",
	};
	key.companies["commsec.com.au"] = {
		label: "same-as:commbank.com.au",
		name: null,
		firstSeenRunId: "run-0",
		lastSeenAt: "t",
	};
	const peopleKey = emptyPeopleKeyFile("mstone", "icp-1");
	peopleKey.people[PERSON_URL] = {
		label: "accept",
		name: "Jane Doe",
		title: "VP Sales",
		company: "commsec.com.au",
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

describe("computeEngineScore same-as subsidiaries", () => {
	it("a buyer at a same-as subsidiary counts under the canonical accepted company", () => {
		const score = computeEngineScore(input());
		expect(score.acceptedPeople).toBe(1);
		expect(score.acceptedCompaniesWithBuyer).toBe(1);
	});
});
