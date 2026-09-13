import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/config";
import { findRun } from "@/core/db/queries";
import { clampCompanies } from "@/workflows/find-people";
import { seedOrganization, wipeOrganizations } from "../support/db";
import { bareCompany } from "./support";

const instances: string[] = [];
afterEach(async () => {
	for (const id of instances) {
		const instance = await testEnv.FIND_PEOPLE.get(id).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
	instances.length = 0;
});

async function primeRosterWorkflow(
	instance: Awaited<ReturnType<typeof introspectWorkflowInstance>>,
	domain: string,
): Promise<void> {
	await instance.modify(async (m) => {
		await m.mockStepResult(
			{ name: "load-companies" },
			{
				companies: [
					{
						...bareCompany(domain),
						id: "company",
						name: "Example",
						exaId: "exact",
					},
				],
				icpId: null,
				unknownDomains: [],
			},
		);
		await m.mockStepResult({ name: "open-run" }, { alreadySpent: 0 });
		await m.mockStepResult({ name: `people-${domain}-open` }, "run-company");
		await m.mockStepResult(
			{ name: `people-${domain}-clay` },
			{
				value: {
					rows: [
						{
							name: "Alex",
							title: "Founder",
							company: "Example",
							url: "https://linkedin.com/in/alex",
							location: null,
							since: null,
						},
					],
					quotaUsed: 1,
					capped: false,
				},
				costDollars: 0,
				error: null,
			},
		);
		await m.mockStepResult({ name: `people-${domain}-clay-bank` }, {});
		await m.mockStepResult({ name: `people-${domain}-roster-evidence` }, {});
		await m.mockStepResult(
			{ name: `people-${domain}-create-company` },
			"company",
		);
		await m.mockStepResult({ name: `people-${domain}-save-roster` }, 1);
		await m.mockStepResult({ name: `people-${domain}-finish` }, {});
		await m.mockStepResult({ name: "close-run" }, {});
	});
}

describe("FindPeopleWorkflow", () => {
	it("clamps requested companies to the single shared cap", () => {
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
	it("runs roster mode in the actual Workflow runtime without granting verified status", async () => {
		const id = `people_roster_${crypto.randomUUID()}`;
		instances.push(id);
		const instance = await introspectWorkflowInstance(testEnv.FIND_PEOPLE, id);
		const domain = "roster.example";
		try {
			await primeRosterWorkflow(instance, domain);
			await testEnv.FIND_PEOPLE.create({
				id,
				params: { domains: [domain], organizationId: "org" },
			});
			await instance.waitForStatus("complete");
			expect(await instance.getOutput()).toMatchObject({
				mode: "roster",
				buyerSource: "none",
				peopleRoster: 1,
				peopleVerified: 0,
				capped: false,
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("workflow failure closure", () => {
	it("closes the run as errored when an opened workflow cannot continue", async () => {
		const org = await seedOrganization("people-workflow-error");
		const id = `people_failure_${crypto.randomUUID()}`;
		instances.push(id);
		const instance = await introspectWorkflowInstance(testEnv.FIND_PEOPLE, id);
		const domain = "failure.example";
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies: [bareCompany(domain)], icpId: null, unknownDomains: [] },
				);
				await m.mockStepError(
					{ name: `people-${domain}-open` },
					new NonRetryableError("Cannot open company"),
				);
			});
			await testEnv.FIND_PEOPLE.create({
				id,
				params: { domains: [domain], organizationId: org.id },
			});
			await instance.waitForStatus("errored");
			const row = await findRun(testEnv, id);
			expect(row?.status).toBe("errored");
			expect(row?.finishedAt).toBeInstanceOf(Date);
		} finally {
			await instance.dispose();
			await wipeOrganizations([org.id]);
		}
	});
});
