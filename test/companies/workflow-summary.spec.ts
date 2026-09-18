import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { config } from "@/config";
import type {
	FindCompaniesResult,
	FindCompaniesStatus,
} from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import { createIcp } from "@/core/db/queries";
import {
	company as companyTable,
	icp as icpTable,
	run,
} from "@/core/db/schema";
import type { SearchPlan } from "@/core/synthesize";
import { profileFixture, requirementFixture } from "../support/icp";

const storedRequirements = [requirementFixture("the company fits the profile")];

async function seedRun(
	label: string,
): Promise<{ organizationId: string; icpId: string }> {
	const org = await organizationForSlug(
		testEnv,
		`companies-summary-${label}-${crypto.randomUUID()}`,
		label,
	);
	const domain = `${label}-${crypto.randomUUID()}.internal`;
	const icpRow = await createIcp(testEnv, {
		domain,
		organizationId: org.id,
		doc: profileFixture(
			{ requirements: storedRequirements },
			`seed profile for the ${label} test`,
			domain,
		),
	});
	return { organizationId: org.id, icpId: icpRow.id };
}

async function cleanup(seed: {
	organizationId: string;
	icpId: string;
	instanceId: string;
}): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(companyTable)
			.where(eq(companyTable.runId, seed.instanceId));
		await connection.delete(run).where(eq(run.id, seed.instanceId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		await connection
			.delete(organization)
			.where(eq(organization.id, seed.organizationId));
	});
}

function companyRow(domain: string): CompanyRow {
	return {
		name: `Co ${domain}`,
		domain,
		linkedinUrl: `https://linkedin.com/company/${domain.replace(/[^a-z0-9]/gi, "-")}`,
		record: null,
		description: null,
	};
}

function planFor(): SearchPlan {
	return {
		query: "fintech companies",
		angle: "angle-1",
		source: "exa-search",
		agentEffort: "low",
		userLocation: null,
		countries: [],
		minWorkforce: null,
		maxWorkforce: null,
		minFoundedYear: null,
		maxFoundedYear: null,
		minRevenueAnnual: null,
		maxRevenueAnnual: null,
		minFundingTotal: null,
		maxFundingTotal: null,
	};
}

function reportFor(plan: SearchPlan, found: number) {
	return {
		round: 1,
		angle: plan.angle,
		query: plan.query,
		source: plan.source,
		agentEffort: plan.agentEffort,
		found,
		rejected: { filter: 0, gate: 0, judge: 0 },
	};
}

function roundResult(
	domains: string[],
	overrides: {
		requested: number;
		status: FindCompaniesStatus;
		costDollars: number;
	},
): FindCompaniesResult {
	const companies = domains.map(companyRow);
	const captures: Record<string, CompanyCapture> = Object.fromEntries(
		domains.map((domain) => [
			domain,
			{
				entity: {
					name: domain,
					description: null,
					industry: null,
					foundedYear: null,
					workforceTotal: null,
					city: null,
					country: null,
					revenueAnnual: null,
					fundingTotal: null,
				},
				result: {
					id: null,
					url: `https://${domain}/`,
					title: domain,
					qualification: {
						index: 0,
						statuses: [],
						reason: "fits the profile",
					},
				},
				evidence: [],
				raw: JSON.stringify({ url: `https://${domain}/` }),
				source: "exa-search",
			},
		]),
	);
	return {
		companies,
		requested: overrides.requested,
		found: companies.length,
		rounds: 1,
		status: overrides.status,
		costDollars: overrides.costDollars,
		rejects: [],
		searches: [planFor()],
		captures,
		seenDomains: domains,
		feedback: [],
		pages: [],
	};
}

describe("what the workflow reports back for the whole run", () => {
	it("returns twelve when the first round finds five and the second finds seven for a target of ten", async () => {
		const seed = await seedRun("round-continuity");
		const instanceId = `companies_round_continuity_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			const first = roundResult(["a.com", "b.com", "c.com", "d.com", "e.com"], {
				requested: 10,
				status: "short",
				costDollars: 0.01,
			});
			const second = roundResult(
				["f.com", "g.com", "h.com", "i.com", "j.com", "k.com", "l.com"],
				{
					requested: 5,
					status: "complete",
					costDollars: 0.01,
				},
			);
			await instance.modify(async (m) => {
				await m.mockStepResult({ name: "round_1" }, first);
				await m.mockStepResult({ name: "round_2" }, second);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 10 },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toMatchObject({
				requested: 10,
				found: 12,
				rounds: 2,
				status: "complete",
			});
			expect(await savedCompanies(instanceId)).toHaveLength(12);
		} finally {
			await instance.dispose();
			await cleanup({ ...seed, instanceId });
		}
	});
});

function savedCompanies(instanceId: string) {
	return withConnection(testEnv, "direct", db, (connection) =>
		connection
			.select()
			.from(companyTable)
			.where(eq(companyTable.runId, instanceId)),
	);
}

describe("what the workflow reports for one round", () => {
	it("retains surplus companies and stops after the completed round reaches its target", async () => {
		const seed = await seedRun("summary-bound");
		const count = 10;
		const domains = Array.from({ length: 12 }, (_, i) => `co-${i}.com`);
		const instanceId = `companies_summary_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "round_1" },
					roundResult(domains, {
						requested: count,
						status: "complete",
						costDollars: 0.05,
					}),
				);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toEqual({
				requested: count,
				found: domains.length,
				rounds: 1,
				status: "complete",
				costDollars: 0.05,
				roundReports: [reportFor(planFor(), domains.length)],
			});
			expect(await savedCompanies(instanceId)).toHaveLength(12);
		} finally {
			await instance.dispose();
			await cleanup({ ...seed, instanceId });
		}
	});

	it("caps the run once a round crosses the spend ceiling, keeping the rows it paid for", async () => {
		const seed = await seedRun("spend-cap");
		const overTheCeiling = config.spend.perRunDollars + 0.01;
		const instanceId = `companies_spend_cap_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "round_1" },
					roundResult(["paid-1.com", "paid-2.com"], {
						requested: 50,
						status: "short",
						costDollars: overTheCeiling,
					}),
				);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 50 },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toEqual({
				requested: 50,
				found: 2,
				rounds: 1,
				status: "capped",
				costDollars: overTheCeiling,
				roundReports: [reportFor(planFor(), 2)],
			});
		} finally {
			await instance.dispose();
			await cleanup({ ...seed, instanceId });
		}
	});
});
