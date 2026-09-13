import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import type { Organization } from "@/core/db/queries";
import {
	openRun,
	saveCompanies,
	saveRunCompanies,
	upsertPeople,
} from "@/core/db/queries";
import { peoplePage } from "@/core/db/run-pages";
import type { Company, Person, Run } from "@/core/db/schema";
import { company, person, runCompany, run as runTable } from "@/core/db/schema";
import type { SubjectsDeps } from "@/core/enrich";
import { subjectsForRun } from "@/core/enrich";
import type { Recorded } from "../support/db";
import { fakeCompanyExists, fakeFindRun, fakeRunPeople } from "../support/db";
import { runRow } from "../support/rows";

function personCompanyRows(
	companyRow: Company,
): { person: Person; company: Company }[] {
	return [
		{
			person: {
				id: "person-1",
				organizationId: "org-1",
				companyId: companyRow.id,
				linkedinUrl: "https://linkedin.com/in/a",
				name: "Ada",
				title: "VP",
				data: null,
			},
			company: companyRow,
		},
		{
			person: {
				id: "person-2",
				organizationId: "org-1",
				companyId: companyRow.id,
				linkedinUrl: null,
				name: null,
				title: null,
				data: null,
			},
			company: companyRow,
		},
	];
}

describe("subjectsForRun: a companies run", () => {
	it("resolves the people of its companies, reading through the direct binding", async () => {
		const run = runRow({
			id: "companies_icp-1_2026-08-27",
			capability: "companies",
		});
		const companyRow: Company = {
			id: "company-1",
			organizationId: "org-1",
			icpId: "icp-1",
			domain: "acme.com",
			name: "Acme",
			linkedinUrl: null,
			description: null,
			selectionReason: null,
			data: null,
			runId: run.id,
			foundAt: new Date(),
		};
		const existsRecorded: Recorded = {};
		const peopleRecorded: Recorded = {};
		const deps: SubjectsDeps = {
			findRun: fakeFindRun(run),
			companyExists: fakeCompanyExists([{ id: companyRow.id }], existsRecorded),
			runPeople: fakeRunPeople(personCompanyRows(companyRow), peopleRecorded),
		};

		const subjects = await subjectsForRun(testEnv, run.id, deps);

		expect(subjects).toEqual([
			{
				id: "person-1",
				domain: "acme.com",
				name: "Ada",
				linkedinUrl: "https://linkedin.com/in/a",
			},
			{ id: "person-2", domain: "acme.com" },
		]);
		expect(existsRecorded.mode).toBe("direct");
		expect(peopleRecorded.mode).toBe("direct");
	});
});

type PeopleRunFixture = {
	org: Organization;
	companiesRunId: string;
	run: Run;
	saved: Company;
};

async function seedPeopleRun(
	mode: string,
	buyerSource: string,
): Promise<PeopleRunFixture> {
	const org = await organizationForSlug(
		testEnv,
		`enrich-subjects-${crypto.randomUUID()}.internal`,
		"enrich-subjects",
	);
	const companiesRunId = `companies_icp-1-${crypto.randomUUID()}`;
	const peopleRunId = `people_icp-1-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: companiesRunId,
		organizationId: org.id,
		icpId: null,
		capability: "companies",
		status: "complete",
	});
	const run = await openRun(testEnv, {
		id: peopleRunId,
		organizationId: org.id,
		icpId: null,
		capability: "people",
		status: "running",
	});
	const [saved] = await saveCompanies(testEnv, [
		{
			icpId: null,
			organizationId: org.id,
			domain: `acme-${crypto.randomUUID()}.com`,
			name: "Acme",
			runId: companiesRunId,
		},
	]);
	if (!saved) throw new Error("seed failed to save a company");
	await saveRunCompanies(testEnv, [
		{
			runId: peopleRunId,
			domain: saved.domain,
			companyId: saved.id,
			identity: "domain",
			mode,
			buyerSource,
		},
	]);
	return { org, companiesRunId, run, saved };
}

async function cleanupPeopleRun(fixture: PeopleRunFixture): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(runCompany)
			.where(eq(runCompany.runId, fixture.run.id));
		await connection.delete(company).where(eq(company.id, fixture.saved.id));
		await connection
			.delete(runTable)
			.where(inArray(runTable.id, [fixture.companiesRunId, fixture.run.id]));
		await connection
			.delete(organization)
			.where(eq(organization.id, fixture.org.id));
	});
}

describe("subjectsForRun: a people run", () => {
	it("resolves the same people for a people run id, scoped through the stored evidence, not an empty set", async () => {
		const fixture = await seedPeopleRun("roster", "none");
		try {
			const rows = personCompanyRows(fixture.saved);
			const deps: SubjectsDeps = {
				findRun: fakeFindRun(fixture.run),
				companyExists: fakeCompanyExists([{ id: fixture.saved.id }]),
				runPeople: fakeRunPeople(rows),
			};

			const subjects = await subjectsForRun(testEnv, fixture.run.id, deps);

			expect(subjects).toEqual(
				rows.map((row) => ({
					id: row.person.id,
					domain: row.company.domain,
					...(row.person.name !== null ? { name: row.person.name } : {}),
					...(row.person.linkedinUrl !== null
						? { linkedinUrl: row.person.linkedinUrl }
						: {}),
				})),
			);
		} finally {
			await cleanupPeopleRun(fixture);
		}
	});
});

async function seedMixedStatusPeople(
	fixture: PeopleRunFixture,
): Promise<{ verifiedId: string }> {
	const [legacy, roster, verified] = await upsertPeople(testEnv, [
		{
			organizationId: fixture.org.id,
			companyId: fixture.saved.id,
			linkedinUrl: `https://linkedin.com/in/legacy-${crypto.randomUUID()}`,
			name: "Legacy Person",
		},
		{
			organizationId: fixture.org.id,
			companyId: fixture.saved.id,
			linkedinUrl: `https://linkedin.com/in/roster-${crypto.randomUUID()}`,
			name: "Roster Person",
			data: {
				status: "roster",
				basis: null,
				seenBy: ["clay"],
				since: null,
				location: null,
			},
		},
		{
			organizationId: fixture.org.id,
			companyId: fixture.saved.id,
			linkedinUrl: `https://linkedin.com/in/verified-${crypto.randomUUID()}`,
			name: "Verified Person",
			data: {
				status: "verified",
				basis: "champion",
				seenBy: ["exa"],
				since: null,
				location: null,
			},
		},
	]);
	if (!legacy || !roster || !verified)
		throw new Error("seed failed to save a person");
	return { verifiedId: verified.id };
}

describe("subjectsForRun: scoped to what the run's mode stored", () => {
	it("enriches only the people the people page for the same run would show", async () => {
		const fixture = await seedPeopleRun("target", "target");
		try {
			const { verifiedId } = await seedMixedStatusPeople(fixture);

			const subjects = await subjectsForRun(testEnv, fixture.run.id);
			const page = await peoplePage(testEnv, fixture.run, {
				limit: 10,
				cursor: undefined,
			});

			expect(subjects.map((subject) => subject.id)).toEqual([verifiedId]);
			expect(page.rows.map((row) => row.id)).toEqual([verifiedId]);
		} finally {
			await withConnection(testEnv, "direct", db, (connection) =>
				connection.delete(person).where(eq(person.companyId, fixture.saved.id)),
			);
			await cleanupPeopleRun(fixture);
		}
	});
});

describe("subjectsForRun: refusals", () => {
	it("throws for a company-less run, an unknown run id, and a capability with no company scope", async () => {
		const companyRun = runRow({
			id: "companies_icp-2_2026-08-27",
			capability: "companies",
		});
		const deps: SubjectsDeps = {
			findRun: fakeFindRun(companyRun),
			companyExists: fakeCompanyExists([]),
			runPeople: fakeRunPeople([]),
		};
		const enrichRun = runRow({
			id: "enrich_icp-1_2026-08-27",
			capability: "enrich",
		});

		await expect(subjectsForRun(testEnv, companyRun.id, deps)).rejects.toThrow(
			NonRetryableError,
		);
		await expect(
			subjectsForRun(testEnv, "unknown_run", {
				findRun: fakeFindRun(undefined),
			}),
		).rejects.toThrow(NonRetryableError);
		await expect(
			subjectsForRun(testEnv, enrichRun.id, {
				findRun: fakeFindRun(enrichRun),
			}),
		).rejects.toThrow(NonRetryableError);
	});
});
