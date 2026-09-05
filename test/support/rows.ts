import type {
	Company,
	Evidence,
	Person,
	Run,
	RunCompany,
} from "@/core/db/schema";
import type { PersonData } from "@/core/people/rows";

export function runCompanyRow(id: string): RunCompany {
	return {
		id,
		runId: "run-1",
		domain: "acme.com",
		companyId: null,
		identity: "unresolved",
		mode: "roster",
		buyerSource: "none",
		spendDollars: 0,
		clayRecords: 0,
		peopleVerified: 0,
		peopleRoster: 0,
	};
}

export function companyRow(id: string): Company {
	return {
		id,
		organizationId: "org-1",
		icpId: "icp-1",
		domain: `${id}.com`,
		name: id,
		linkedinUrl: null,
		industry: null,
		data: null,
		runId: "run-1",
		foundAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

export function personRow(id: string): Person {
	return {
		id,
		organizationId: "org-1",
		companyId: "company-1",
		linkedinUrl: `https://linkedin.com/in/${id}`,
		name: id,
		title: null,
		data: null,
	};
}

export function verifiedPersonData(
	overrides: Partial<PersonData> = {},
): PersonData {
	return {
		status: "verified",
		basis: "champion",
		seenBy: ["clay"],
		since: null,
		location: null,
		...overrides,
	};
}

export function rosterPersonData(
	overrides: Partial<PersonData> = {},
): PersonData {
	return {
		status: "roster",
		basis: null,
		seenBy: ["clay"],
		since: null,
		location: null,
		...overrides,
	};
}

export function evidenceRow(fields: {
	kind: string;
	value: string;
	source: string;
	status: string | null;
	seenAt: Date;
}): Evidence {
	return {
		id: "evidence-1",
		subjectType: "person",
		subjectId: "subject-1",
		confidence: null,
		...fields,
	};
}

export function runRow(overrides: Partial<Run> = {}): Run {
	return {
		id: "companies_icp-1_2026-08-27",
		organizationId: "org-1",
		icpId: "icp-1",
		capability: "companies",
		status: "running",
		costDollars: 0,
		startedAt: new Date("2026-08-27T00:00:00.000Z"),
		finishedAt: null,
		...overrides,
	};
}
