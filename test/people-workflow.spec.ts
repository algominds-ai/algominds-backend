import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import type {
	FindPeopleResult,
	PeopleCompany,
	PersonCandidate,
} from "../src/core/people";
import type { IcpDoc } from "../src/core/synthesize";

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

let companySeq = 0;

function testCompany(fields: {
	domain: string;
	name: string;
	exaId?: string | null;
}): PeopleCompany {
	companySeq += 1;
	return {
		id: `company-${companySeq}`,
		domain: fields.domain,
		name: fields.name,
		exaId: fields.exaId ?? null,
	};
}

const SCOPES = [
	"batches-test",
	"no-people-test",
	"domains-batches-test",
	"unknown-run-test",
	"people-found-test",
	"known-people-test",
];

async function terminateStartedRuns(): Promise<void> {
	for (const scope of SCOPES) {
		const instance = await testEnv.FIND_PEOPLE.get(scope).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
}

afterEach(terminateStartedRuns);

describe("FindPeopleWorkflow: runId", () => {
	it("resolves companies for a companies runId, truncates them, and runs one step per batch of five", async () => {
		const instanceId = "batches-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			const companies = Array.from({ length: 7 }, (_, i) =>
				testCompany({ domain: `run-${i}.com`, name: `Run ${i}` }),
			);
			const batchZero: FindPeopleResult = {
				companies: [
					{
						domain: "run-0.com",
						people: [],
						apolloOnly: [],
						reason: "no people found for this company",
					},
				],
				searched: 5,
				skippedCompanies: 0,
				costDollars: 0.05,
			};
			const batchOne: FindPeopleResult = {
				companies: [
					{
						domain: "run-5.com",
						people: [],
						apolloOnly: [],
						reason: "no people found for this company",
					},
				],
				searched: 2,
				skippedCompanies: 0,
				costDollars: 0.02,
			};

			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies, icpId: "icp-1", unknownDomains: [] },
				);
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, accountId: "account-1" },
				);
				await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
				await m.mockStepResult(
					{ name: "people-plan" },
					{
						titles: ["VP of Sales"],
						queryTemplate: "decision makers at {company}",
						userLocation: null,
						costDollars: 0,
					},
				);
				await m.mockStepResult({ name: "known-people" }, []);
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "people-batch-0" }, batchZero);
				await m.mockStepResult({ name: "people-batch-1" }, batchOne);
				await m.mockStepResult({ name: "save-people" }, {});
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-1_test" },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				searched: 7,
				skippedCompanies: 0,
				peopleFound: 0,
				costDollars: 0.05 + 0.02,
				unknownDomains: [],
				knownDomains: [],
				capped: false,
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("FindPeopleWorkflow: an empty run", () => {
	it("resolves a run with no companies and completes without a person-batch step", async () => {
		const instanceId = "no-people-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies: [], icpId: "icp-empty", unknownDomains: [] },
				);
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, accountId: "account-1" },
				);
				await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
				await m.mockStepResult(
					{ name: "people-plan" },
					{
						titles: ["VP of Sales"],
						queryTemplate: "decision makers at {company}",
						userLocation: null,
						costDollars: 0,
					},
				);
				await m.mockStepResult({ name: "known-people" }, []);
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "save-people" }, {});
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-empty_test" },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				searched: 0,
				skippedCompanies: 0,
				peopleFound: 0,
				costDollars: 0,
				unknownDomains: [],
				knownDomains: [],
				capped: false,
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("FindPeopleWorkflow: domains and errors", () => {
	it("resolves companies for a domains request and reports the domain that named no company", async () => {
		const instanceId = "domains-batches-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			const target = testCompany({ domain: "target.com", name: "Target Co" });
			const batchZero: FindPeopleResult = {
				companies: [
					{
						domain: "target.com",
						people: [],
						apolloOnly: [],
						reason: "no people found for this company",
					},
				],
				searched: 1,
				skippedCompanies: 0,
				costDollars: 0.01,
			};

			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{
						companies: [target],
						icpId: "icp-domains",
						unknownDomains: ["missing.com"],
					},
				);
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, accountId: "account-1" },
				);
				await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
				await m.mockStepResult(
					{ name: "people-plan" },
					{
						titles: ["VP of Sales"],
						queryTemplate: "decision makers at {company}",
						userLocation: null,
						costDollars: 0,
					},
				);
				await m.mockStepResult({ name: "known-people" }, []);
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "people-batch-0" }, batchZero);
				await m.mockStepResult({ name: "save-people" }, {});
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { domains: ["target.com", "missing.com"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				searched: 1,
				skippedCompanies: 0,
				peopleFound: 0,
				costDollars: 0.01,
				unknownDomains: ["missing.com"],
				knownDomains: [],
				capped: false,
			});
		} finally {
			await instance.dispose();
		}
	});

	it("errors rather than completing when the named run was never opened", async () => {
		const instanceId = "unknown-run-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: `companies_never-opened-${instanceId}` },
			});
			await instance.waitForStatus("errored");
		} finally {
			await instance.dispose();
		}
	});
});

describe("FindPeopleWorkflow: skipping companies with already-known people", () => {
	it("excludes a company already known and reports it separately from a truncated one", async () => {
		const instanceId = "known-people-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			const known = testCompany({ domain: "known-co.com", name: "Known Co" });
			const fresh = Array.from({ length: 5 }, (_, i) =>
				testCompany({ domain: `fresh-${i}.com`, name: `Fresh ${i}` }),
			);
			const theOnlyMockedBatch: FindPeopleResult = {
				companies: fresh.map((c) => ({
					domain: c.domain,
					people: [],
					apolloOnly: [],
					reason: "no people found for this company",
				})),
				searched: 5,
				skippedCompanies: 0,
				costDollars: 0.05,
			};

			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{
						companies: [known, ...fresh],
						icpId: "icp-1",
						unknownDomains: [],
					},
				);
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, accountId: "account-1" },
				);
				await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
				await m.mockStepResult(
					{ name: "people-plan" },
					{
						titles: ["VP of Sales"],
						queryTemplate: "decision makers at {company}",
						userLocation: null,
						costDollars: 0,
					},
				);
				await m.mockStepResult({ name: "known-people" }, [known.domain]);
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "people-batch-0" }, theOnlyMockedBatch);
				await m.mockStepResult({ name: "save-people" }, {});
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-1_test" },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				searched: 5,
				skippedCompanies: 0,
				peopleFound: 0,
				costDollars: 0.05,
				unknownDomains: [],
				knownDomains: ["known-co.com"],
				capped: false,
			});
		} finally {
			await instance.dispose();
		}
	});
});

function testPerson(fullName: string): PersonCandidate {
	return {
		fullName,
		linkedinUrl: `https://linkedin.com/in/${fullName.toLowerCase()}`,
		title: "VP of Sales",
		rawTitle: "VP of Sales",
		location: null,
		employment: [],
		apolloMatched: false,
		entity: {
			fullName,
			currentTitle: "VP of Sales",
			currentCompany: null,
			location: null,
		},
		result: {
			id: null,
			url: `https://linkedin.com/in/${fullName.toLowerCase()}`,
			title: fullName,
			publishedDate: null,
			score: null,
		},
	};
}

describe("FindPeopleWorkflow: the summary output", () => {
	it("counts every person found across companies, without carrying the row arrays", async () => {
		const instanceId = "people-found-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			const companies = [
				testCompany({ domain: "one.com", name: "One Co" }),
				testCompany({ domain: "two.com", name: "Two Co" }),
			];
			const batchZero: FindPeopleResult = {
				companies: [
					{
						domain: "one.com",
						people: [testPerson("Jane Doe"), testPerson("Jo Roe")],
						apolloOnly: [],
						reason: null,
					},
					{
						domain: "two.com",
						people: [testPerson("Sam Lee")],
						apolloOnly: [],
						reason: null,
					},
				],
				searched: 2,
				skippedCompanies: 0,
				costDollars: 0.02,
			};

			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies, icpId: "icp-1", unknownDomains: [] },
				);
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, accountId: "account-1" },
				);
				await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
				await m.mockStepResult(
					{ name: "people-plan" },
					{
						titles: ["VP of Sales"],
						queryTemplate: "decision makers at {company}",
						userLocation: null,
						costDollars: 0,
					},
				);
				await m.mockStepResult({ name: "known-people" }, []);
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "people-batch-0" }, batchZero);
				await m.mockStepResult({ name: "save-people" }, {});
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-1_test" },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				searched: 2,
				skippedCompanies: 0,
				peopleFound: 3,
				costDollars: 0.02,
				unknownDomains: [],
				knownDomains: [],
				capped: false,
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("FindPeopleWorkflow: the per-run spend ceiling", () => {
	it("stops after the batch that crossed the ceiling and reports the run as capped", async () => {
		const instanceId = "people-spend-ceiling-test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			const companies = Array.from({ length: 10 }, (_, i) =>
				testCompany({ domain: `co-${i}.com`, name: `Co ${i}` }),
			);
			const overTheCeiling = config.spend.perRunDollars + 0.01;
			const batchZero: FindPeopleResult = {
				companies: companies.slice(0, 5).map((company) => ({
					domain: company.domain,
					people: [],
					apolloOnly: [],
					reason: null,
				})),
				searched: 5,
				skippedCompanies: 0,
				costDollars: overTheCeiling,
			};

			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "load-companies" },
					{ companies, icpId: "icp-1", unknownDomains: [] },
				);
				await m.mockStepResult(
					{ name: "load-icp" },
					{ doc: icp, accountId: "account-1" },
				);
				await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
				await m.mockStepResult(
					{ name: "people-plan" },
					{
						titles: ["VP of Sales"],
						queryTemplate: "decision makers at {company}",
						userLocation: null,
						costDollars: 0,
					},
				);
				await m.mockStepResult({ name: "known-people" }, []);
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "people-batch-0" }, batchZero);
				await m.mockStepResult({ name: "save-people" }, {});
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-1_spend" },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toEqual({
				searched: 5,
				skippedCompanies: 0,
				peopleFound: 0,
				costDollars: overTheCeiling,
				unknownDomains: [],
				knownDomains: [],
				capped: true,
			});
		} finally {
			await instance.dispose();
		}
	});
});
