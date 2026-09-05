import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { config } from "@/config";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { findRun } from "@/core/db/queries";
import { run } from "@/core/db/schema";
import type { Candidate } from "@/core/people/candidate";
import { clampCompanies } from "@/workflows/find-people";
import { seedOrganization } from "../support/db";
import { bareCompany } from "./support";

const SCOPES = [
	"people_workflow_unresolved_test",
	"people_workflow_roster_test",
];

const FindPeopleSummarySchema = z.object({
	companiesSearched: z.number(),
	peopleVerified: z.number(),
	peopleRoster: z.number(),
	costDollars: z.number(),
	unknownDomains: z.array(z.string()),
	capped: z.boolean(),
	mode: z.enum(["roster", "profile", "target"]),
	buyerSource: z.enum(["target", "captured", "description", "none"]),
});

async function summaryOf(
	instance: Awaited<ReturnType<typeof introspectWorkflowInstance>>,
): Promise<z.infer<typeof FindPeopleSummarySchema>> {
	return FindPeopleSummarySchema.parse(await instance.getOutput());
}

type StepMocker = {
	mockStepResult: (step: { name: string }, value: unknown) => Promise<void>;
};

async function primeRunLevelSteps(m: StepMocker): Promise<void> {
	await m.mockStepResult({ name: "open-run" }, { alreadySpent: 0 });
	await m.mockStepResult({ name: "close-run" }, { closed: true });
}

async function primeUnresolvedCompanySteps(
	m: StepMocker,
	domain: string,
): Promise<void> {
	await m.mockStepResult({ name: `people-${domain}-open` }, "rc-1");
	await m.mockStepResult(
		{ name: `people-${domain}-identity` },
		{ how: "unresolved", clayRecords: 0, costEntries: [] },
	);
	await m.mockStepResult({ name: `people-${domain}-unresolved` }, {});
}

async function primeRosterCompanySteps(
	m: StepMocker,
	domain: string,
	candidate: Candidate,
): Promise<void> {
	await m.mockStepResult({ name: `people-${domain}-open` }, "rc-1");
	await m.mockStepResult(
		{ name: `people-${domain}-identity` },
		{
			how: "domain",
			identifier: domain,
			name: "Google",
			clayRecords: 1,
			costEntries: [],
		},
	);
	await m.mockStepResult(
		{ name: `people-${domain}-create-company` },
		"company-1",
	);
	await m.mockStepResult(
		{ name: `people-${domain}-roster` },
		{ candidates: [candidate], clayRecords: 5, costEntries: [] },
	);
	await m.mockStepResult({ name: `people-${domain}-save` }, { count: 1 });
	await m.mockStepResult({ name: `people-${domain}-spend` }, { total: 0 });
}

afterEach(async () => {
	for (const scope of SCOPES) {
		const instance = await testEnv.FIND_PEOPLE.get(scope).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
});

describe("FindPeopleWorkflow: identity resolution", () => {
	it("reports an unresolved domain without searching people", async () => {
		const domain = "notacompany.example";
		const instanceId = "people_workflow_unresolved_test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies: [bareCompany(domain)], icpId: null, unknownDomains: [] },
				);
				await primeRunLevelSteps(m);
				await primeUnresolvedCompanySteps(m, domain);
				await m.mockStepError(
					{ name: `people-${domain}-create-company` },
					new NonRetryableError(
						"an unresolved domain must never reach create-company",
					),
				);
				await m.mockStepError(
					{ name: `people-${domain}-roster` },
					new NonRetryableError(
						"an unresolved domain must never search the roster",
					),
				);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { domains: [domain], organizationId: "org-1" },
			});
			await instance.waitForStatus("complete");

			const output = await summaryOf(instance);
			expect(output.unknownDomains).toEqual([domain]);
			expect(output.companiesSearched).toBe(1);
			expect(output.peopleRoster).toBe(0);
			expect(output.costDollars).toBe(0);
		} finally {
			await instance.dispose();
		}
	});
});

const rosterCandidate = {
	id: 0,
	name: "Riley Chen",
	title: "VP Marketing",
	company: "Google",
	url: "https://linkedin.com/in/riley-chen-roster",
	location: null,
	since: null,
	seenBy: ["clay:vp"],
};

describe("FindPeopleWorkflow: roster mode", () => {
	it("returns a bare-domain senior roster without judging it", async () => {
		const domain = "google.com";
		const instanceId = "people_workflow_roster_test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies: [bareCompany(domain)], icpId: null, unknownDomains: [] },
				);
				await primeRunLevelSteps(m);
				await primeRosterCompanySteps(m, domain, rosterCandidate);
				await m.mockStepError(
					{ name: `people-${domain}-select` },
					new NonRetryableError("roster mode must never call the selector"),
				);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { domains: [domain], organizationId: "org-1" },
			});
			await instance.waitForStatus("complete");

			const output = await summaryOf(instance);
			expect(output.mode).toBe("roster");
			expect(output.buyerSource).toBe("none");
			expect(output.peopleRoster).toBe(1);
			expect(output.peopleVerified).toBe(0);
			expect(output.unknownDomains).toEqual([]);
		} finally {
			await instance.dispose();
		}
	});
});

describe("FindPeopleWorkflow: the company cap", () => {
	it("uses one cap in every mode, regardless of the caller's own number", () => {
		const companies = Array.from({ length: 101 }, (_, i) =>
			bareCompany(`company-${i}.example`),
		);

		expect(clampCompanies(companies, undefined)).toHaveLength(
			config.limits.maxCompaniesPerPeopleRun,
		);
		expect(clampCompanies(companies, 5000)).toHaveLength(
			config.limits.maxCompaniesPerPeopleRun,
		);
		expect(clampCompanies(companies, 3)).toHaveLength(3);
	});
});

describe("FindPeopleWorkflow: a step that throws after the run opens", () => {
	it("leaves the run row errored, with finished_at set, instead of running forever", async () => {
		const org = await seedOrganization("people-workflow-close-errored");
		const domain = `close-errored-${crypto.randomUUID()}.example`;
		const instanceId = `people_close_errored_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies: [bareCompany(domain)], icpId: null, unknownDomains: [] },
				);
				await m.mockStepResult({ name: `people-${domain}-open` }, "rc-1");
				const failed = new NonRetryableError("a step failed");
				await m.mockStepError({ name: `people-${domain}-identity` }, failed);
				await m.mockStepError({ name: `people-${domain}-failed` }, failed);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { domains: [domain], organizationId: org.id },
			});
			await instance.waitForStatus("errored");

			const row = await findRun(testEnv, instanceId);
			expect(row?.status).toBe("errored");
			expect(row?.finishedAt).toBeInstanceOf(Date);
		} finally {
			await instance.dispose();
			await withConnection(testEnv, "direct", db, (connection) =>
				connection.delete(run).where(eq(run.id, instanceId)),
			);
			await withConnection(testEnv, "direct", db, (connection) =>
				connection.delete(organization).where(eq(organization.id, org.id)),
			);
		}
	});
});
