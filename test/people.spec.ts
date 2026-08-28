import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { CostLedger } from "../src/core/cost";
import { db } from "../src/core/db/client";
import {
	createIcp,
	ensureAccount,
	openRun,
	saveCompanies,
} from "../src/core/db/queries";
import { account, company, icp as icpTable, run } from "../src/core/db/schema";
import type {
	FindPeopleDeps,
	FindPeopleOptions,
	FindPeopleResult,
	PeopleCompany,
} from "../src/core/people";
import {
	findPeople,
	normalizeTitle,
	resolveMaxCompanies,
	toPersonData,
} from "../src/core/people";
import type { ApolloSearchResult } from "../src/core/providers/apollo";
import type { ExaResult, ExaSearchRequest } from "../src/core/providers/exa";
import type { IcpDoc } from "../src/core/synthesize";
import { loadTargetCompanies } from "../src/workflows/find-people";

async function rawSource(path: string): Promise<string> {
	const mod: { default: string } = await import(`${path}?raw`);
	return mod.default;
}

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

let companySeq = 0;

function testCompany(fields: { domain: string; name: string }): PeopleCompany {
	companySeq += 1;
	return {
		id: `company-${companySeq}`,
		domain: fields.domain,
		name: fields.name,
	};
}

function testOpts(
	overrides: Partial<FindPeopleOptions> = {},
): FindPeopleOptions {
	return { icp, env: testEnv, ...overrides };
}

function scriptedTitles(
	titles: string[],
): FindPeopleDeps["decisionMakerTitles"] {
	return async () => ({ titles, ledger: new CostLedger() });
}

function personResult(
	fields: {
		fullName?: string | null;
		currentTitle?: string | null;
		currentCompany?: string | null;
		location?: string | null;
	},
	url: string,
): ExaResult {
	const summary: Record<string, string> = {};
	if (fields.fullName) summary.fullName = fields.fullName;
	if (fields.currentTitle) summary.currentTitle = fields.currentTitle;
	if (fields.currentCompany) summary.currentCompany = fields.currentCompany;
	if (fields.location) summary.location = fields.location;
	return { url, title: fields.fullName ?? "profile", summary, company: null };
}

function scriptedSearch(perCall: ExaResult[][]): {
	search: FindPeopleDeps["search"];
	calls: ExaSearchRequest[];
} {
	const calls: ExaSearchRequest[] = [];
	const search: FindPeopleDeps["search"] = async (req, _env, ledger) => {
		const results = perCall[calls.length] ?? [];
		calls.push(req);
		ledger.reported("exa", "search", 0.01);
		return { requestId: `req-${calls.length}`, results };
	};
	return { search, calls };
}

function scriptedApollo(
	perCall: (ApolloSearchResult | null)[],
): FindPeopleDeps["apolloSearch"] {
	let call = 0;
	return async () => {
		const result = perCall[call] ?? null;
		call += 1;
		return result;
	};
}

function testDeps(
	search: FindPeopleDeps["search"],
	apolloResults: (ApolloSearchResult | null)[],
	titles: string[] = ["VP of Sales"],
): FindPeopleDeps {
	return {
		decisionMakerTitles: scriptedTitles(titles),
		search,
		apolloSearch: scriptedApollo(apolloResults),
	};
}

describe("normalizeTitle", () => {
	it("cuts a headline at the @ and keeps the leading title", () => {
		expect(
			normalizeTitle("SVP of Sales @ Ramp (I'm hiring - ramp.com/careers)"),
		).toBe("SVP of Sales");
	});

	it("cuts at a pipe when no @ or parenthesis is present", () => {
		expect(normalizeTitle("VP of Sales | Ramp")).toBe("VP of Sales");
	});

	it("leaves a plain title untouched", () => {
		expect(normalizeTitle("Director, Revenue Enablement")).toBe(
			"Director, Revenue Enablement",
		);
	});
});

describe("findPeople: a company with no results", () => {
	it("yields an empty people list with a reason, and the run still succeeds", async () => {
		const company = testCompany({ domain: "empty.com", name: "Empty Co" });
		const { search } = scriptedSearch([[]]);

		const result = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);

		expect(result.companies).toEqual([
			{
				domain: "empty.com",
				people: [],
				apolloOnly: [],
				reason: expect.any(String),
			},
		]);
	});
});

describe("findPeople: employer disagreement", () => {
	it("keeps both employer claims and lowers confidence when currentCompany differs from the target", async () => {
		const company = testCompany({ domain: "acme.com", name: "Acme" });
		const result = personResult(
			{
				fullName: "Jane Doe",
				currentTitle: "VP of Sales",
				currentCompany: "Globex",
				location: "New York",
			},
			"https://linkedin.com/in/janedoe",
		);
		const { search } = scriptedSearch([[result]]);

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);
		const person = found.companies[0]?.people[0];

		expect(person?.employment).toEqual([
			{ company: "Globex", confidence: 1, source: "exa" },
			{ company: "Acme", confidence: 0.4, source: "target" },
		]);
		expect(person?.employmentConfidence).toBe(0.4);
	});

	it("records one high-confidence claim when currentCompany matches the target", async () => {
		const company = testCompany({ domain: "ramp.com", name: "Ramp" });
		const result = personResult(
			{
				fullName: "Max Freeman",
				currentTitle: "SVP of Sales",
				currentCompany: "Ramp",
				location: "San Francisco",
			},
			"https://linkedin.com/in/maxfreeman",
		);
		const { search } = scriptedSearch([[result]]);

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);
		const person = found.companies[0]?.people[0];

		expect(person?.employment).toEqual([
			{ company: "Ramp", confidence: 1, source: "exa" },
		]);
		expect(person?.employmentConfidence).toBe(1);
	});
});

describe("findPeople: title normalisation", () => {
	it("normalises a raw LinkedIn headline and keeps the raw text as evidence", async () => {
		const raw = "SVP of Sales @ Ramp (I'm hiring - ramp.com/careers)";
		const company = testCompany({ domain: "ramp.com", name: "Ramp" });
		const result = personResult(
			{ fullName: "Max Freeman", currentTitle: raw, currentCompany: "Ramp" },
			"https://linkedin.com/in/maxfreeman",
		);
		const { search } = scriptedSearch([[result]]);

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);
		const person = found.companies[0]?.people[0];

		expect(person?.title).toBe("SVP of Sales");
		expect(person?.rawTitle).toBe(raw);
	});
});

describe("findPeople: dedupe by LinkedIn URL", () => {
	it("collapses the same LinkedIn URL found under two companies into one person", async () => {
		const companyA = testCompany({ domain: "a.com", name: "A Co" });
		const companyB = testCompany({ domain: "b.com", name: "B Co" });
		const sharedUrl = "https://linkedin.com/in/samlee";
		const resultA = personResult(
			{ fullName: "Sam Lee", currentTitle: "CEO", currentCompany: "A Co" },
			sharedUrl,
		);
		const resultB = personResult(
			{ fullName: "Sam Lee", currentTitle: "CEO", currentCompany: "A Co" },
			sharedUrl,
		);
		const { search } = scriptedSearch([[resultA], [resultB]]);

		const found = await findPeople(
			[companyA, companyB],
			testOpts(),
			testDeps(search, [null, null]),
		);

		expect(found.companies[0]?.people).toHaveLength(1);
		expect(found.companies[1]?.people).toHaveLength(0);
	});

	it("keeps two people who share a name but have different LinkedIn URLs separate", async () => {
		const companyA = testCompany({ domain: "a.com", name: "A Co" });
		const companyB = testCompany({ domain: "b.com", name: "B Co" });
		const resultA = personResult(
			{ fullName: "Sam Lee", currentTitle: "CEO", currentCompany: "A Co" },
			"https://linkedin.com/in/samlee-a",
		);
		const resultB = personResult(
			{ fullName: "Sam Lee", currentTitle: "CEO", currentCompany: "B Co" },
			"https://linkedin.com/in/samlee-b",
		);
		const { search } = scriptedSearch([[resultA], [resultB]]);

		const found = await findPeople(
			[companyA, companyB],
			testOpts(),
			testDeps(search, [null, null]),
		);

		expect(found.companies[0]?.people).toHaveLength(1);
		expect(found.companies[1]?.people).toHaveLength(1);
	});
});

describe("findPeople: maxCompanies", () => {
	it("truncates to maxCompanies before any search and reports how many were skipped", async () => {
		const companies = Array.from({ length: 250 }, (_, i) =>
			testCompany({ domain: `company-${i}.com`, name: `Company ${i}` }),
		);
		const { search, calls } = scriptedSearch(
			Array.from({ length: 100 }, () => []),
		);
		const apolloResults = Array.from({ length: 100 }, () => null);

		const result = await findPeople(
			companies,
			testOpts({ maxCompanies: 100 }),
			testDeps(search, apolloResults),
		);

		expect(result.searched).toBe(100);
		expect(result.skippedCompanies).toBe(150);
		expect(calls).toHaveLength(100);
	});
});

describe("resolveMaxCompanies", () => {
	it("uses the caller's own number even when it is above the configured fallback", () => {
		const requested = config.limits.defaultMaxCompaniesPerPeopleRun + 50;
		expect(resolveMaxCompanies(requested)).toBe(requested);
	});

	it("falls back to the configured default when the caller gives none", () => {
		expect(resolveMaxCompanies(undefined)).toBe(
			config.limits.defaultMaxCompaniesPerPeopleRun,
		);
	});

	it("clamps a request beyond the configured ceiling instead of rejecting it", () => {
		expect(
			resolveMaxCompanies(config.limits.maxCompaniesPerPeopleRun + 500),
		).toBe(config.limits.maxCompaniesPerPeopleRun);
	});
});

type SeededScope = {
	accountId: string;
	icpId: string;
	runIds: string[];
};

async function seedIcp(
	label: string,
): Promise<{ accountId: string; icpId: string }> {
	const acct = await ensureAccount(
		testEnv,
		`run-scope-test-${label}`,
		`run-scope-test-${label}-${crypto.randomUUID()}.internal`,
	);
	const icpRow = await createIcp(testEnv, {
		description: "seed icp for run-scoping tests",
		domain: acct.domain,
		accountId: acct.id,
	});
	return { accountId: acct.id, icpId: icpRow.id };
}

async function seedRun(
	scope: { accountId: string; icpId: string },
	runId: string,
): Promise<void> {
	await openRun(testEnv, {
		id: runId,
		accountId: scope.accountId,
		icpId: scope.icpId,
		capability: "companies",
		status: "complete",
	});
}

async function cleanupSeed(seed: SeededScope): Promise<void> {
	const connection = db(testEnv, "direct");
	await connection.delete(company).where(inArray(company.runId, seed.runIds));
	await connection.delete(run).where(inArray(run.id, seed.runIds));
	await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
	await connection.delete(account).where(eq(account.id, seed.accountId));
}

describe("loadTargetCompanies: runId", () => {
	it("loads only the named run's companies, not every company ever found for the profile", async () => {
		const label = `run-scope-${crypto.randomUUID()}`;
		const { accountId, icpId } = await seedIcp(label);
		const oldRunId = `companies_${label}-old`;
		const newRunId = `companies_${label}-new`;
		await seedRun({ accountId, icpId }, oldRunId);
		await seedRun({ accountId, icpId }, newRunId);
		await saveCompanies(testEnv, [
			{ icpId, runId: oldRunId, domain: `old-${label}.com`, name: "Old Co" },
		]);
		await saveCompanies(testEnv, [
			{ icpId, runId: newRunId, domain: `new-${label}.com`, name: "New Co" },
		]);

		try {
			const target = await loadTargetCompanies(testEnv, { runId: newRunId });

			expect(target.icpId).toBe(icpId);
			expect(target.unknownDomains).toEqual([]);
			expect(target.companies.map((c) => c.domain)).toEqual([
				`new-${label}.com`,
			]);
			expect(
				target.companies.some((c) => c.domain === `old-${label}.com`),
			).toBe(false);
		} finally {
			await cleanupSeed({ accountId, icpId, runIds: [oldRunId, newRunId] });
		}
	});

	it("completes with an empty company list for a run that exists but found none", async () => {
		const label = `run-empty-${crypto.randomUUID()}`;
		const { accountId, icpId } = await seedIcp(label);
		const runId = `companies_${label}`;
		await seedRun({ accountId, icpId }, runId);

		try {
			const target = await loadTargetCompanies(testEnv, { runId });

			expect(target.companies).toEqual([]);
			expect(target.icpId).toBe(icpId);
		} finally {
			await cleanupSeed({ accountId, icpId, runIds: [runId] });
		}
	});

	it("throws for a run id that was never opened, rather than falling back to the whole profile", async () => {
		await expect(
			loadTargetCompanies(testEnv, {
				runId: `companies_never-opened-${crypto.randomUUID()}`,
			}),
		).rejects.toThrow();
	});
});

describe("loadTargetCompanies: domains", () => {
	it("loads exactly the companies matching the given domains", async () => {
		const label = `domains-${crypto.randomUUID()}`;
		const { accountId, icpId } = await seedIcp(label);
		const runId = `companies_${label}`;
		await seedRun({ accountId, icpId }, runId);
		const domainA = `a-${label}.com`;
		const domainB = `b-${label}.com`;
		const domainC = `c-${label}.com`;
		await saveCompanies(testEnv, [
			{ icpId, runId, domain: domainA, name: "A Co" },
			{ icpId, runId, domain: domainB, name: "B Co" },
			{ icpId, runId, domain: domainC, name: "C Co" },
		]);

		try {
			const target = await loadTargetCompanies(testEnv, {
				domains: [domainA, domainC],
			});

			expect(target.icpId).toBe(icpId);
			expect(target.unknownDomains).toEqual([]);
			expect(new Set(target.companies.map((c) => c.domain))).toEqual(
				new Set([domainA, domainC]),
			);
		} finally {
			await cleanupSeed({ accountId, icpId, runIds: [runId] });
		}
	});

	it("reports a domain naming no known company instead of silently dropping it", async () => {
		const label = `domains-partial-${crypto.randomUUID()}`;
		const { accountId, icpId } = await seedIcp(label);
		const runId = `companies_${label}`;
		await seedRun({ accountId, icpId }, runId);
		const known = `known-${label}.com`;
		const missing = `missing-${label}.com`;
		await saveCompanies(testEnv, [
			{ icpId, runId, domain: known, name: "Known Co" },
		]);

		try {
			const target = await loadTargetCompanies(testEnv, {
				domains: [known, missing],
			});

			expect(target.companies.map((c) => c.domain)).toEqual([known]);
			expect(target.unknownDomains).toEqual([missing]);
		} finally {
			await cleanupSeed({ accountId, icpId, runIds: [runId] });
		}
	});

	it("throws when no domain in the list matches a known company", async () => {
		await expect(
			loadTargetCompanies(testEnv, {
				domains: [`nobody-knows-${crypto.randomUUID()}.com`],
			}),
		).rejects.toThrow();
	});
});

describe("findPeople: Apollo coverage", () => {
	it("returns an Apollo row with no Exa match as a candidate with no email path", async () => {
		const company = testCompany({ domain: "ramp.com", name: "Ramp" });
		const { search } = scriptedSearch([[]]);
		const apolloResult: ApolloSearchResult = {
			totalEntries: 1,
			candidates: [
				{
					id: "apollo-1",
					firstName: "Kyle",
					lastNameObfuscated: "Ba***n",
					title: "Director, Revenue Enablement",
					organizationName: "Ramp",
					hasEmail: false,
					hasDirectPhone: false,
					lastRefreshedAt: null,
				},
			],
		};

		const result = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [apolloResult]),
		);

		expect(result.companies[0]?.apolloOnly).toEqual([
			{
				firstName: "Kyle",
				lastNameObfuscated: "Ba***n",
				title: "Director, Revenue Enablement",
				organizationName: "Ramp",
				hasEmailPath: false,
			},
		]);
	});

	it("marks an Exa person as apollo-matched when a candidate shares first name and company", async () => {
		const company = testCompany({ domain: "ramp.com", name: "Ramp" });
		const result = personResult(
			{
				fullName: "Max Freeman",
				currentTitle: "SVP of Sales",
				currentCompany: "Ramp",
			},
			"https://linkedin.com/in/maxfreeman",
		);
		const { search } = scriptedSearch([[result]]);
		const apolloResult: ApolloSearchResult = {
			totalEntries: 1,
			candidates: [
				{
					id: "apollo-1",
					firstName: "Max",
					lastNameObfuscated: "Fr***n",
					title: "SVP of Sales",
					organizationName: "Ramp",
					hasEmail: true,
					hasDirectPhone: false,
					lastRefreshedAt: null,
				},
			],
		};

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [apolloResult]),
		);

		expect(found.companies[0]?.people[0]?.apolloMatched).toBe(true);
		expect(found.companies[0]?.apolloOnly).toEqual([]);
	});
});

describe("findPeople: direct call", () => {
	it("is called with plain companies, options, and deps, with no Hono context and no WorkflowStep", async () => {
		const company = testCompany({ domain: "plain.com", name: "Plain Co" });
		const { search } = scriptedSearch([[]]);

		const result: FindPeopleResult = await findPeople(
			[company],
			{ icp, env: testEnv, maxCompanies: 5 },
			testDeps(search, [null]),
		);

		expect(result.searched).toBe(1);
	});
});

describe("findPeople: capturing the vendor payload", () => {
	it("captures the full entity, including the raw current company evidence never reads on its own", async () => {
		const company = testCompany({ domain: "acme.com", name: "Acme" });
		const result = personResult(
			{
				fullName: "Jane Doe",
				currentTitle: "VP of Sales",
				currentCompany: "Acme",
				location: "New York",
			},
			"https://linkedin.com/in/janedoe",
		);
		const { search } = scriptedSearch([[result]]);

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);
		const person = found.companies[0]?.people[0];

		expect(person?.entity).toEqual({
			fullName: "Jane Doe",
			currentTitle: "VP of Sales",
			currentCompany: "Acme",
			location: "New York",
		});
	});

	it("captures a profile missing its location with that field null, not a thrown error", async () => {
		const company = testCompany({ domain: "acme.com", name: "Acme" });
		const result = personResult(
			{ fullName: "Jane Doe", currentTitle: "VP of Sales" },
			"https://linkedin.com/in/janedoe",
		);
		const { search } = scriptedSearch([[result]]);

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);
		const person = found.companies[0]?.people[0];

		expect(person?.entity.location).toBeNull();
		expect(person?.result).toEqual({
			url: "https://linkedin.com/in/janedoe",
			title: "Jane Doe",
			publishedDate: null,
			score: null,
		});
	});

	it("keeps the fields evidence reads unchanged now that the vendor capture rides alongside them", async () => {
		const company = testCompany({ domain: "acme.com", name: "Acme" });
		const result = personResult(
			{
				fullName: "Jane Doe",
				currentTitle: "VP of Sales",
				currentCompany: "Acme",
				location: "New York",
			},
			"https://linkedin.com/in/janedoe",
		);
		const { search } = scriptedSearch([[result]]);

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);
		const person = found.companies[0]?.people[0];

		expect(person).toMatchObject({
			fullName: "Jane Doe",
			rawTitle: "VP of Sales",
			title: "VP of Sales",
			location: "New York",
		});
		expect(person?.employment).toEqual([
			{ company: "Acme", confidence: 1, source: "exa" },
		]);
	});
});

describe("toPersonData", () => {
	it("names the provider that produced the capture", () => {
		const data = toPersonData(
			{
				fullName: "Jane Doe",
				currentTitle: null,
				currentCompany: null,
				location: null,
			},
			{
				url: "https://linkedin.com/in/janedoe",
				title: "Jane Doe",
				publishedDate: null,
				score: null,
			},
			"exa",
		);

		expect(data.provider).toBe("exa");
	});
});

async function unitSource(): Promise<string> {
	const core = await rawSource("../src/core/people.ts");
	const workflow = await rawSource("../src/workflows/find-people.ts");
	return `${core}\n${workflow}`;
}

describe("static checks", () => {
	it("never constructs a ToolLoopAgent", async () => {
		expect(await unitSource()).not.toMatch(/ToolLoopAgent/);
	});

	it("never calls an Apollo reveal, people/match, or bulk_match endpoint", async () => {
		expect(await unitSource()).not.toMatch(
			/people\/match|bulk_match|\/reveal|apolloReveal/i,
		);
	});

	it("imports only Apollo's free people-search provider", async () => {
		expect(await unitSource()).toMatch(/apolloPeopleSearch/);
	});
});

const SCOPES = [
	"batches-test",
	"no-people-test",
	"domains-batches-test",
	"unknown-run-test",
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
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "people-batch-0" }, batchZero);
				await m.mockStepResult({ name: "people-batch-1" }, batchOne);
				await m.mockStepResult({ name: "save-people" }, null);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-1_test" },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				companies: [...batchZero.companies, ...batchOne.companies],
				searched: 7,
				skippedCompanies: 0,
				costDollars: 0.05 + 0.02,
				unknownDomains: [],
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
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "save-people" }, null);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { runId: "companies_icp-empty_test" },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				companies: [],
				searched: 0,
				skippedCompanies: 0,
				costDollars: 0,
				unknownDomains: [],
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
				await m.mockStepResult({ name: "open-run" }, { id: "x" });
				await m.mockStepResult({ name: "close-run" }, { id: "x" });
				await m.mockStepResult({ name: "people-batch-0" }, batchZero);
				await m.mockStepResult({ name: "save-people" }, null);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { domains: ["target.com", "missing.com"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				companies: batchZero.companies,
				searched: 1,
				skippedCompanies: 0,
				costDollars: 0.01,
				unknownDomains: ["missing.com"],
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
