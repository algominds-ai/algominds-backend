import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import * as exaAgent from "../src/core/providers/exa/agent";
import * as providers from "../src/core/providers/index";
import * as findPeopleWorkflow from "../src/workflows/find-people";
import * as findPeopleTarget from "../src/workflows/find-people-target";

const icp = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

const SCOPES = ["shell-summary-test"];

async function terminateStartedRuns(): Promise<void> {
	for (const scope of SCOPES) {
		const instance = await testEnv.FIND_PEOPLE.get(scope).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
}

afterEach(terminateStartedRuns);

describe("FindPeopleWorkflow: the replacement shell", () => {
	it("returns an empty summary from the replacement shell", async () => {
		const instanceId = "shell-summary-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{
						companies: [
							{
								id: "company-1",
								domain: "acme.com",
								name: "Acme",
								linkedinUrl: null,
								icpId: "icp-1",
							},
							{
								id: "company-2",
								domain: "beta.com",
								name: "Beta",
								linkedinUrl: null,
								icpId: "icp-1",
							},
						],
						icpId: "icp-1",
						unknownDomains: [],
					},
				);
				await m.mockStepResult(
					{ name: "load-profile" },
					{ doc: icp, organizationId: "org-1" },
				);
				await m.mockStepResult(
					{ name: "resolve-buyer" },
					{
						mode: "roster",
						buyerSource: "none",
						rubric: null,
						bands: ["founder", "owner"],
						keywordBands: [],
					},
				);
				await m.mockStepResult({ name: "open-run" }, { alreadySpent: 0 });
				await m.mockStepResult({ name: "close-run" }, null);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-1_test", organizationId: "org-1" },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				companiesSearched: 0,
				peopleVerified: 0,
				peopleRoster: 0,
				costDollars: 0,
				unknownDomains: [],
				capped: false,
				mode: "roster",
				buyerSource: "none",
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("FindPeopleWorkflow: no legacy people entry points", () => {
	it("has no legacy people entry points", () => {
		expect(Object.keys(findPeopleWorkflow).sort()).toEqual([
			"FindPeopleWorkflow",
		]);
		expect(Object.keys(findPeopleTarget).sort()).toEqual([
			"companiesOfOneProfile",
			"loadTargetCompanies",
		]);
		expect(Object.keys(exaAgent).sort()).toEqual([
			"ExaAgentCompanySchema",
			"ExaAgentVerdictSchema",
			"LINKEDIN_COMPANY_URL_PATTERN",
			"agentLinkedinUrl",
			"buildVerdictRunRequest",
			"getAgentRun",
			"getAgentRunOutput",
			"getAgentVerdictRun",
			"startAgentRun",
		]);
		expect(Object.keys(providers).sort()).toEqual([
			"COMPANY",
			"EMAIL",
			"EMPLOYMENT",
			"LINKEDIN",
		]);
	});
});
