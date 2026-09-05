import { env as testEnv } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import type { Organization } from "@/core/db/queries";
import { openRun } from "@/core/db/queries";
import type { Evidence } from "@/core/db/schema";
import { company, evidence, person, run, runCompany } from "@/core/db/schema";
import type { TargetCompany } from "@/workflows/find-people-target";

export function bareCompany(domain: string): TargetCompany {
	return {
		id: null,
		domain,
		name: null,
		linkedinUrl: null,
		icpId: null,
		workforceTotal: null,
	};
}

export type SeededPeopleRun = { org: Organization; runId: string };

/** A real organization with an already-open "people" run, for a test to run one company through. */
export async function seedPeopleRun(label: string): Promise<SeededPeopleRun> {
	const org = await organizationForSlug(
		testEnv,
		`people-${label}-${crypto.randomUUID()}.internal`,
		`people ${label} test`,
	);
	const runId = `people_${label}_${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: org.id,
		icpId: null,
		capability: "people",
		status: "running",
	});
	return { org, runId };
}

/** Deletes every row a people run may have written: its evidence, people, run_company rows, companies, the run, and the organization. */
export async function cleanupPeopleRun(seed: SeededPeopleRun): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		const runCompanyRows = await connection
			.select()
			.from(runCompany)
			.where(eq(runCompany.runId, seed.runId));
		const personRows = await connection
			.select()
			.from(person)
			.where(eq(person.organizationId, seed.org.id));
		const evidenceSubjectIds = [
			...runCompanyRows.map((row) => row.id),
			...personRows.map((row) => row.id),
		];
		if (evidenceSubjectIds.length > 0) {
			await connection
				.delete(evidence)
				.where(inArray(evidence.subjectId, evidenceSubjectIds));
		}
		await connection
			.delete(person)
			.where(eq(person.organizationId, seed.org.id));
		await connection.delete(runCompany).where(eq(runCompany.runId, seed.runId));
		await connection
			.delete(company)
			.where(eq(company.organizationId, seed.org.id));
		await connection.delete(run).where(eq(run.id, seed.runId));
		await connection
			.delete(organization)
			.where(eq(organization.id, seed.org.id));
	});
}

export async function runCompanyRowsFor(runId: string) {
	return withConnection(testEnv, "direct", db, (connection) =>
		connection.select().from(runCompany).where(eq(runCompany.runId, runId)),
	);
}

export async function companyRowsFor(organizationId: string) {
	return withConnection(testEnv, "direct", db, (connection) =>
		connection
			.select()
			.from(company)
			.where(eq(company.organizationId, organizationId)),
	);
}

export async function personRowsFor(organizationId: string) {
	return withConnection(testEnv, "direct", db, (connection) =>
		connection
			.select()
			.from(person)
			.where(eq(person.organizationId, organizationId)),
	);
}

export async function evidenceRowsFor(subjectId: string): Promise<Evidence[]> {
	return withConnection(testEnv, "direct", db, (connection) =>
		connection.select().from(evidence).where(eq(evidence.subjectId, subjectId)),
	);
}

export type VerifyCandidate = {
	id: number;
	name: string;
	title: string;
	company: string;
	url: string;
	location: null;
	since: null;
	seenBy: string[];
};

export function verifyCandidate(
	id: number,
	name: string,
	title: string,
	url: string,
): VerifyCandidate {
	return {
		id,
		name,
		title,
		company: "Verify Target Co",
		url,
		location: null,
		since: null,
		seenBy: ["clay:c-suite"],
	};
}

export const CONFIRMED_VERDICT = {
	verdict: "CONFIRMED",
	evidence_url: "https://news.example/jordan-blake-joins-as-vp-sales",
	evidence_quote: "Jordan Blake leads sales as VP Sales.",
	evidence_kind: "press",
	confidence: 0.9,
};

export const UNKNOWN_VERDICT = {
	verdict: "UNKNOWN",
	evidence_url: null,
	evidence_quote: null,
	evidence_kind: null,
	confidence: 0.1,
};

export const CONTRADICTED_VERDICT = {
	verdict: "CONTRADICTED",
	evidence_url: null,
	evidence_quote: null,
	evidence_kind: null,
	confidence: 0.2,
};

export const AGGREGATOR_CONFIRMED_VERDICT = {
	verdict: "CONFIRMED",
	evidence_url: "https://peoplesite.example/jordan-blake",
	evidence_quote: "Jordan Blake — VP Sales",
	evidence_kind: "aggregator",
	confidence: 0.5,
};

export const UNKNOWN_VERDICT_WITH_URL = {
	verdict: "UNKNOWN",
	evidence_url: "https://verifytarget.example/unclear",
	evidence_quote: "an ambiguous mention of the role",
	evidence_kind: null,
	confidence: 0.3,
};

export const JORDAN_BLAKE_ROSTER_ROW = {
	name: "Jordan Blake",
	url: "https://linkedin.com/in/jordan-blake",
	title: "VP Sales",
	company: "Verify Target Co",
};
