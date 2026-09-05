import { env as testEnv } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "@/config";
import { db, withConnection } from "@/core/db/client";
import {
	createIcp,
	openRun,
	saveCompanies,
	saveRunCompanies,
	upsertPeople,
} from "@/core/db/queries";
import {
	company,
	icp as icpTable,
	person,
	run,
	runCompany,
} from "@/core/db/schema";
import app from "@/index";
import { issueOrganizationKey } from "../support/db";

const BASE = "https://algo.test";

let TOKEN = "";
let CALLER_ORGANIZATION_ID = "";

beforeAll(async () => {
	const issued = await issueOrganizationKey(
		`pages-listing-caller-${crypto.randomUUID()}`,
	);
	TOKEN = issued.key;
	CALLER_ORGANIZATION_ID = issued.organizationId;
});

async function call(path: string): Promise<Response> {
	return app.fetch(
		new Request(`${BASE}${path}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
		testEnv,
	);
}

type PageSeed = { icpId: string; runId: string; companyIds: string[] };

async function seedRunWithCompanies(
	label: string,
	count: number,
): Promise<PageSeed> {
	const icpRow = await createIcp(testEnv, {
		description: "seed icp for run-page tests",
		domain: `pages-test-${label}.internal`,
		organizationId: CALLER_ORGANIZATION_ID,
	});
	const runId = `companies_${label}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: CALLER_ORGANIZATION_ID,
		icpId: icpRow.id,
		capability: "companies",
		status: "complete",
	});
	const saved = await saveCompanies(
		testEnv,
		Array.from({ length: count }, (_, i) => ({
			icpId: icpRow.id,
			organizationId: CALLER_ORGANIZATION_ID,
			runId,
			domain: `${label}-${i}.com`,
			name: `${label} Co ${i}`,
		})),
	);
	return { icpId: icpRow.id, runId, companyIds: saved.map((row) => row.id) };
}

async function cleanupPageSeed(seed: PageSeed): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(person)
			.where(inArray(person.companyId, seed.companyIds));
		await connection.delete(company).where(eq(company.runId, seed.runId));
		await connection.delete(run).where(eq(run.id, seed.runId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
	});
}

type CompanyPageBody = {
	rows: Array<{ id: string; domain: string }>;
	nextCursor: string | null;
	limit: number;
};

describe("GET /runs/:runId/companies: pagination and the page-size ceiling", () => {
	it("pages through a run's companies with no duplicate and no gap", async () => {
		const seed = await seedRunWithCompanies(
			`companies-page-${crypto.randomUUID()}`,
			5,
		);
		try {
			const first = await call(`/runs/${seed.runId}/companies?limit=2`);
			const firstBody: CompanyPageBody = await first.json();
			const second = await call(
				`/runs/${seed.runId}/companies?limit=2&cursor=${firstBody.nextCursor}`,
			);
			const secondBody: CompanyPageBody = await second.json();
			const third = await call(
				`/runs/${seed.runId}/companies?limit=2&cursor=${secondBody.nextCursor}`,
			);
			const thirdBody: CompanyPageBody = await third.json();
			const seenIds = [
				...firstBody.rows,
				...secondBody.rows,
				...thirdBody.rows,
			].map((row) => row.id);

			expect(firstBody.rows).toHaveLength(2);
			expect(secondBody.rows).toHaveLength(2);
			expect(thirdBody.rows).toHaveLength(1);
			expect(thirdBody.nextCursor).toBeNull();
			expect(new Set(seenIds)).toEqual(new Set(seed.companyIds));
		} finally {
			await cleanupPageSeed(seed);
		}
	});

	it("clamps a limit above the configured maximum and reports the clamped value", async () => {
		const seed = await seedRunWithCompanies(
			`companies-clamp-${crypto.randomUUID()}`,
			1,
		);
		try {
			const response = await call(`/runs/${seed.runId}/companies?limit=999999`);
			const body: CompanyPageBody = await response.json();
			expect(body.limit).toBe(config.limits.maxRunPageSize);
			expect(body.limit).toBeLessThan(999999);
		} finally {
			await cleanupPageSeed(seed);
		}
	});
});

describe("GET /runs/:runId/people: scoped to the given run's own companies", () => {
	it("returns people for the given run's companies only, not another run's", async () => {
		const seedA = await seedRunWithCompanies(
			`people-a-${crypto.randomUUID()}`,
			1,
		);
		const seedB = await seedRunWithCompanies(
			`people-b-${crypto.randomUUID()}`,
			1,
		);
		try {
			const [companyIdA] = seedA.companyIds;
			const [companyIdB] = seedB.companyIds;
			if (!companyIdA || !companyIdB)
				throw new Error("seed produced no company");
			await upsertPeople(testEnv, [
				{
					organizationId: CALLER_ORGANIZATION_ID,
					companyId: companyIdA,
					linkedinUrl: `https://linkedin.com/in/page-a-${crypto.randomUUID()}`,
					name: "Person A",
				},
			]);
			await upsertPeople(testEnv, [
				{
					organizationId: CALLER_ORGANIZATION_ID,
					companyId: companyIdB,
					linkedinUrl: `https://linkedin.com/in/page-b-${crypto.randomUUID()}`,
					name: "Person B",
				},
			]);

			const response = await call(`/runs/${seedA.runId}/people`);
			const body: { rows: Array<{ name: string | null }> } =
				await response.json();
			expect(body.rows).toHaveLength(1);
			expect(body.rows[0]?.name).toBe("Person A");
		} finally {
			await cleanupPageSeed(seedA);
			await cleanupPageSeed(seedB);
		}
	});
});

type PeopleReportSeed = {
	runId: string;
	companyId: string;
	resolvedDomain: string;
	unresolvedDomain: string;
};

async function seedPeopleReport(label: string): Promise<PeopleReportSeed> {
	const runId = `people_${label}`;
	const resolvedDomain = `${label}-resolved.com`;
	const unresolvedDomain = `${label}-unresolved.example`;
	await openRun(testEnv, {
		id: runId,
		organizationId: CALLER_ORGANIZATION_ID,
		icpId: null,
		capability: "people",
		status: "running",
	});
	const [saved] = await saveCompanies(testEnv, [
		{
			icpId: null,
			organizationId: CALLER_ORGANIZATION_ID,
			runId,
			domain: resolvedDomain,
			name: `${label} Co`,
		},
	]);
	if (!saved) throw new Error("seed produced no company");
	await saveRunCompanies(testEnv, [
		{
			runId,
			domain: resolvedDomain,
			companyId: saved.id,
			identity: "domain",
			mode: "target",
			buyerSource: "target",
			spendDollars: 0.12,
		},
		{
			runId,
			domain: unresolvedDomain,
			companyId: null,
			identity: "unresolved",
			mode: null,
			buyerSource: null,
		},
	]);
	await upsertPeople(testEnv, [
		{
			organizationId: CALLER_ORGANIZATION_ID,
			companyId: saved.id,
			linkedinUrl: `https://linkedin.com/in/${label}`,
			name: "Report Person",
			data: {
				status: "verified",
				basis: "buyer fit",
				seenBy: ["clay"],
				since: null,
				location: null,
			},
		},
	]);
	return { runId, companyId: saved.id, resolvedDomain, unresolvedDomain };
}

async function cleanupPeopleReport(seed: PeopleReportSeed): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(person).where(eq(person.companyId, seed.companyId));
		await connection.delete(runCompany).where(eq(runCompany.runId, seed.runId));
		await connection.delete(company).where(eq(company.runId, seed.runId));
		await connection.delete(run).where(eq(run.id, seed.runId));
	});
}

type ReportCompanyRow = {
	domain: string;
	mode: string | null;
	spendDollars: number;
	company: { id: string } | null;
};

describe("GET /runs/:runId for a people run: the durable per-domain report", () => {
	it("reads the durable report, distinguishing a resolved domain's spend from an unresolved one", async () => {
		const seed = await seedPeopleReport(`people-report-${crypto.randomUUID()}`);
		try {
			const companies = await call(`/runs/${seed.runId}/companies`);
			const companiesBody: { rows: ReportCompanyRow[] } =
				await companies.json();
			const resolved = companiesBody.rows.find(
				(row) => row.domain === seed.resolvedDomain,
			);
			const unresolved = companiesBody.rows.find(
				(row) => row.domain === seed.unresolvedDomain,
			);
			const people = await call(`/runs/${seed.runId}/people`);
			const peopleBody: { rows: Array<{ data: { status: string } | null }> } =
				await people.json();

			expect(resolved?.company?.id).toBe(seed.companyId);
			expect(resolved?.mode).toBe("target");
			expect(resolved?.spendDollars).toBeGreaterThan(0);
			expect(unresolved?.company).toBeNull();
			expect(peopleBody.rows).toHaveLength(1);
			expect(peopleBody.rows[0]?.data?.status).toBe("verified");
		} finally {
			await cleanupPeopleReport(seed);
		}
	});
});
