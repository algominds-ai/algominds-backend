import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import type { FindCompaniesDeps, FindCompaniesOptions } from "@/core/companies";
import { gate } from "@/core/companies/gate";
import { CostLedger } from "@/core/cost";
import { closeErroredRun, findRun } from "@/core/db/queries";
import type { ExaResult } from "@/core/providers/exa/search";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import { runRoundBody } from "@/workflows/find-companies-persist";
import { companyIdentityEvidence } from "../support/companies";
import { seedOrganization, seedRunFor, wipeOrganizations } from "../support/db";
import { profileFixture, requirementFixture } from "../support/icp";
import { fakeWorkflowStep } from "../support/step";

const icp: IcpDoc = profileFixture();

const recordRequirement = requirementFixture("the company is a bank");

function plan(): SearchPlan {
	return {
		query: "banks",
		angle: "banking",
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

function exaResult(domain: string): ExaResult {
	return {
		id: null,
		url: `https://${domain}/`,
		title: domain,
		summary: null,
		person: null,
		company: {
			name: domain,
			description: "a company",
			industry: null,
			foundedYear: null,
			workforceTotal: 900,
			city: null,
			country: "United Kingdom",
			revenueAnnual: null,
			fundingTotal: null,
		},
	};
}

/** A round whose vendor calls each mutate the ledger they are handed, then whose judge always gives up, the way a judge exhausted by two model timeouts does. */
function spendThenGiveUpDeps(): FindCompaniesDeps {
	return {
		recentDomains: async () => [],
		synthesize: async () => {
			const ledger = new CostLedger();
			ledger.reported("test-model", "synthesize", 0.03);
			return { route: "search", plans: [plan()], ledger };
		},
		search: async (_plan, _req, _env, ledger) => {
			ledger.reported("test-vendor", "search", 0.02);
			return { requestId: "req-1", results: [exaResult("bank.com")] };
		},
		agentRound: async () => ({ requestId: "agent-1", results: [] }),
		backfill: async (domains) =>
			domains.map((domain) => ({ domain, record: null })),
		retrieveEvidence: async ({ rows }, _env, ledger) => {
			ledger.reported("test-vendor", "retrieve-evidence", 0.01);
			return { evidenceByRow: companyIdentityEvidence(rows), pages: [] };
		},
		gate,
		judge: async () => {
			throw new NonRetryableError("the judge gave up after two model timeouts");
		},
	};
}

function options(env: Env): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env,
		today: "2026-09-05",
		requirements: [recordRequirement],
	};
}

describe("a round that fails after it already spent something", () => {
	let seededOrgId: string | null = null;

	afterEach(async () => {
		if (seededOrgId) await wipeOrganizations([seededOrgId]);
		seededOrgId = null;
	});

	it("banks the vendor spend the round made before the judge gave up, and a repeated close never adds more", async () => {
		const org = await seedOrganization("round-spend");
		seededOrgId = org.id;
		const run = await seedRunFor(org, "companies", { status: "running" });
		const { step } = fakeWorkflowStep();

		let thrown: unknown;
		try {
			await runRoundBody({
				env: testEnv,
				step,
				runId: run.id,
				round: 1,
				alreadySpent: 0,
				icp,
				remaining: 5,
				opts: options(testEnv),
				deps: spendThenGiveUpDeps(),
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(NonRetryableError);
		const banked = await findRun(testEnv, run.id);
		expect(banked?.costDollars).toBeCloseTo(0.06, 9);

		await closeErroredRun(testEnv, run.id);
		const closedOnce = await findRun(testEnv, run.id);
		expect(closedOnce?.status).toBe("errored");
		expect(closedOnce?.costDollars).toBeCloseTo(0.06, 9);

		await closeErroredRun(testEnv, run.id);
		const closedTwice = await findRun(testEnv, run.id);
		expect(closedTwice?.costDollars).toBeCloseTo(0.06, 9);
	});
});
