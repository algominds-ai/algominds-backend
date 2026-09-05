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
import type { Requirement } from "@/core/requirements";
import type { SearchPlan } from "@/core/synthesize";
import { reportRound, roundPlan } from "@/workflows/find-companies-persist";

const storedRequirements: Requirement[] = [
	{
		id: "r1",
		text: "the company fits the profile",
		kind: "hard",
		proof: "record",
		windowDays: null,
	},
];

async function seedRun(
	label: string,
): Promise<{ organizationId: string; icpId: string }> {
	const org = await organizationForSlug(
		testEnv,
		`companies-summary-${label}-${crypto.randomUUID()}`,
		label,
	);
	const icpRow = await createIcp(testEnv, {
		description: `seed profile for the ${label} test`,
		domain: `${label}-${crypto.randomUUID()}.internal`,
		organizationId: org.id,
		requirements: storedRequirements,
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
		linkedinUrl: null,
		evidenceUrl: `https://${domain}`,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: null,
		evidenceDate: null,
	};
}

function planFor(): SearchPlan {
	return {
		query: "fintech companies",
		angle: "angle-1",
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
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
		recency: plan.recency,
		eventWindowDays: null,
		recencyDays: null,
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
					signal: null,
					quote: null,
					publisher: null,
					kind: null,
					publishedDate: null,
					score: null,
					evidenceCheck: null,
					fitReason: null,
				},
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
	it("returns a summary bounded whatever the number of companies found", async () => {
		const seed = await seedRun("summary-bound");
		const count = 50;
		const domains = Array.from({ length: count }, (_, i) => `co-${i}.com`);
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
				found: count,
				rounds: 1,
				status: "complete",
				costDollars: 0.05,
				roundReports: [reportFor(planFor(), count)],
			});
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

describe("a round's stored plan keeps every angle it searched", () => {
	it("keeps every angle a round searched, and is null for a round that found none", () => {
		const plans = [planFor(), { ...planFor(), angle: "payroll" }];

		expect(roundPlan(plans)).toEqual(plans);
		expect(roundPlan([])).toBeNull();
	});
});

describe("a round reports the freshness it demanded", () => {
	it("shows the window the plan asked for, and null when it asked for none", () => {
		const empty = roundResult([], {
			requested: 1,
			status: "complete",
			costDollars: 0,
		});
		const withWindow = reportRound(1, {
			...empty,
			searches: [
				{ ...planFor(), recency: "A role posted in the last 30 days." },
			],
		});
		const without = reportRound(1, { ...empty, searches: [planFor()] });

		expect(withWindow.recency).toBe("A role posted in the last 30 days.");
		expect(without.recency).toBeNull();
		expect(withWindow.source).toBe("exa-search");
	});
});
