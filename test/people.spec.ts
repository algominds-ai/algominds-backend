import { env as testEnv } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { organization } from "../src/core/db/auth-schema";
import { db } from "../src/core/db/client";
import { organizationForSlug } from "../src/core/db/organizations";
import { createIcp, openRun, saveCompanies } from "../src/core/db/queries";
import { company, icp as icpTable, run } from "../src/core/db/schema";
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
	splitKnownCompanies,
	toPersonData,
} from "../src/core/people";
import type { ApolloSearchResult } from "../src/core/providers/apollo/index";
import type {
	ExaResult,
	ExaSearchRequest,
} from "../src/core/providers/exa/search";
import type { IcpDoc } from "../src/core/synthesize";
import {
	companiesOfOneProfile,
	loadTargetCompanies,
} from "../src/workflows/find-people-target";

async function rawSource(path: string): Promise<string> {
	const mod: { default: string } = await import(`${path}?raw`);
	return mod.default;
}

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

function testOpts(
	overrides: Partial<FindPeopleOptions> = {},
): FindPeopleOptions {
	return {
		icp,
		env: testEnv,
		plan: {
			titles: ["VP of Sales"],
			queryTemplate: "decision makers at {company}",
			userLocation: null,
		},
		...overrides,
	};
}

function scriptedPlan(titles: string[] = ["VP of Sales"]) {
	return {
		titles,
		queryTemplate: "decision makers at {company}",
		userLocation: null,
	};
}

type WorkHistoryFixture = {
	title?: string | null;
	current?: boolean;
	companyId?: string | null;
	companyName?: string | null;
};

function personResult(
	fields: {
		fullName?: string | null;
		location?: string | null;
		workHistory?: WorkHistoryFixture[];
	},
	url: string,
): ExaResult {
	const person =
		fields.fullName === undefined
			? null
			: {
					fullName: fields.fullName,
					location: fields.location ?? null,
					workHistory: (fields.workHistory ?? []).map((entry) => ({
						title: entry.title ?? null,
						from: null,
						current: entry.current ?? true,
						companyId: entry.companyId ?? null,
						companyName: entry.companyName ?? null,
					})),
				};
	return {
		id: null,
		url,
		title: fields.fullName ?? "profile",
		summary: null,
		company: null,
		person,
	};
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
	_titles: string[] = ["VP of Sales"],
): FindPeopleDeps {
	return {
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

describe("findPeople: employment settled by company id", () => {
	it("matches a person whose current role names the target company's id", async () => {
		const company = testCompany({
			domain: "ramp.com",
			name: "Ramp",
			exaId: "https://exa.ai/library/organization/ramp",
		});
		const result = personResult(
			{
				fullName: "Max Freeman",
				location: "San Francisco",
				workHistory: [
					{
						title: "SVP of Sales",
						companyId: "https://exa.ai/library/organization/ramp",
						companyName: "Ramp",
					},
				],
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
	});

	it("does not match a person at a different company sharing the target's name (the measured Passage collision)", async () => {
		const company = testCompany({
			domain: "passage-one.com",
			name: "Passage",
			exaId: "https://exa.ai/library/organization/passage-one",
		});
		const result = personResult(
			{
				fullName: "Jane Doe",
				workHistory: [
					{
						title: "VP of Sales",
						companyId: "https://exa.ai/library/organization/passage-two",
						companyName: "Passage",
					},
				],
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
			{ company: "Passage", confidence: 1, source: "exa" },
			{ company: "Passage", confidence: 0.4, source: "target" },
		]);
	});
});

describe("findPeople: employment settled by name when the id comparison is impossible", () => {
	it("matches by name when the target company has no recorded id (a legacy row)", async () => {
		const company = testCompany({ domain: "acme.com", name: "Acme" });
		const result = personResult(
			{
				fullName: "Jane Doe",
				workHistory: [{ title: "VP of Sales", companyName: "Acme" }],
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
			{ company: "Acme", confidence: 1, source: "exa" },
		]);
	});

	it("matches by name when the work history entry carries no company id of its own", async () => {
		const company = testCompany({
			domain: "acme.com",
			name: "Acme",
			exaId: "https://exa.ai/library/organization/acme",
		});
		const result = personResult(
			{
				fullName: "Jane Doe",
				workHistory: [
					{ title: "Founder", companyId: null, companyName: "Acme" },
				],
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
			{ company: "Acme", confidence: 1, source: "exa" },
		]);
	});
});

describe("findPeople: employment edge cases", () => {
	it("does not treat a role that has ended as current", async () => {
		const company = testCompany({
			domain: "acme.com",
			name: "Acme",
			exaId: "https://exa.ai/library/organization/acme",
		});
		const result = personResult(
			{
				fullName: "Jane Doe",
				workHistory: [
					{
						title: "Former VP of Sales",
						current: false,
						companyId: "https://exa.ai/library/organization/acme",
						companyName: "Acme",
					},
				],
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
			{ company: "Acme", confidence: 0.4, source: "target" },
		]);
	});

	it("reports a person with no work history instead of dropping them", async () => {
		const company = testCompany({ domain: "acme.com", name: "Acme" });
		const result = personResult(
			{ fullName: "Jane Doe" },
			"https://linkedin.com/in/janedoe",
		);
		const { search } = scriptedSearch([[result]]);

		const found = await findPeople(
			[company],
			testOpts(),
			testDeps(search, [null]),
		);
		const person = found.companies[0]?.people[0];

		expect(person?.fullName).toBe("Jane Doe");
		expect(person?.employment).toEqual([
			{ company: "Acme", confidence: 0.4, source: "target" },
		]);
	});
});

describe("findPeople: title normalisation", () => {
	it("normalises a raw LinkedIn headline and keeps the raw text as evidence", async () => {
		const raw = "SVP of Sales @ Ramp (I'm hiring - ramp.com/careers)";
		const company = testCompany({ domain: "ramp.com", name: "Ramp" });
		const result = personResult(
			{
				fullName: "Max Freeman",
				workHistory: [{ title: raw, companyName: "Ramp" }],
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
			{
				fullName: "Sam Lee",
				workHistory: [{ title: "CEO", companyName: "A Co" }],
			},
			sharedUrl,
		);
		const resultB = personResult(
			{
				fullName: "Sam Lee",
				workHistory: [{ title: "CEO", companyName: "A Co" }],
			},
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
			{
				fullName: "Sam Lee",
				workHistory: [{ title: "CEO", companyName: "A Co" }],
			},
			"https://linkedin.com/in/samlee-a",
		);
		const resultB = personResult(
			{
				fullName: "Sam Lee",
				workHistory: [{ title: "CEO", companyName: "B Co" }],
			},
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

describe("splitKnownCompanies", () => {
	it("holds back a company whose domain is already known", () => {
		const known = testCompany({ domain: "known.com", name: "Known Co" });
		const fresh = testCompany({ domain: "fresh.com", name: "Fresh Co" });

		const result = splitKnownCompanies([known, fresh], new Set(["known.com"]));

		expect(result.companies).toEqual([fresh]);
		expect(result.skipped).toEqual(["known.com"]);
	});

	it("keeps every company when none is already known", () => {
		const companies = [
			testCompany({ domain: "a.com", name: "A Co" }),
			testCompany({ domain: "b.com", name: "B Co" }),
		];

		const result = splitKnownCompanies(companies, new Set());

		expect(result.companies).toEqual(companies);
		expect(result.skipped).toEqual([]);
	});

	it("normalizes a domain before comparing it against the known set", () => {
		const company = testCompany({
			domain: "https://WWW.Acme.com/careers",
			name: "Acme",
		});

		const result = splitKnownCompanies([company], new Set(["acme.com"]));

		expect(result.companies).toEqual([]);
		expect(result.skipped).toEqual(["https://WWW.Acme.com/careers"]);
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
	organizationId: string;
	icpId: string;
	runIds: string[];
};

async function seedIcp(
	label: string,
): Promise<{ organizationId: string; icpId: string }> {
	const org = await organizationForSlug(
		testEnv,
		`run-scope-test-${label}-${crypto.randomUUID()}.internal`,
		`run-scope-test-${label}`,
	);
	const icpRow = await createIcp(testEnv, {
		description: "seed icp for run-scoping tests",
		domain: org.slug,
		organizationId: org.id,
	});
	return { organizationId: org.id, icpId: icpRow.id };
}

async function seedRun(
	scope: { organizationId: string; icpId: string },
	runId: string,
): Promise<void> {
	await openRun(testEnv, {
		id: runId,
		organizationId: scope.organizationId,
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
	await connection
		.delete(organization)
		.where(eq(organization.id, seed.organizationId));
}

describe("loadTargetCompanies: runId", () => {
	it("loads only the named run's companies, not every company ever found for the profile", async () => {
		const label = `run-scope-${crypto.randomUUID()}`;
		const { organizationId, icpId } = await seedIcp(label);
		const oldRunId = `companies_${label}-old`;
		const newRunId = `companies_${label}-new`;
		await seedRun({ organizationId, icpId }, oldRunId);
		await seedRun({ organizationId, icpId }, newRunId);
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
			await cleanupSeed({
				organizationId,
				icpId,
				runIds: [oldRunId, newRunId],
			});
		}
	});

	it("completes with an empty company list for a run that exists but found none", async () => {
		const label = `run-empty-${crypto.randomUUID()}`;
		const { organizationId, icpId } = await seedIcp(label);
		const runId = `companies_${label}`;
		await seedRun({ organizationId, icpId }, runId);

		try {
			const target = await loadTargetCompanies(testEnv, { runId });

			expect(target.companies).toEqual([]);
			expect(target.icpId).toBe(icpId);
		} finally {
			await cleanupSeed({ organizationId, icpId, runIds: [runId] });
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
		const { organizationId, icpId } = await seedIcp(label);
		const runId = `companies_${label}`;
		await seedRun({ organizationId, icpId }, runId);
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
			await cleanupSeed({ organizationId, icpId, runIds: [runId] });
		}
	});

	it("reports a domain naming no known company instead of silently dropping it", async () => {
		const label = `domains-partial-${crypto.randomUUID()}`;
		const { organizationId, icpId } = await seedIcp(label);
		const runId = `companies_${label}`;
		await seedRun({ organizationId, icpId }, runId);
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
			await cleanupSeed({ organizationId, icpId, runIds: [runId] });
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
				workHistory: [{ title: "SVP of Sales", companyName: "Ramp" }],
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
			{ icp, env: testEnv, plan: scriptedPlan(), maxCompanies: 5 },
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
				location: "New York",
				workHistory: [{ title: "VP of Sales", companyName: "Acme" }],
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
			{ fullName: "Jane Doe", workHistory: [{ title: "VP of Sales" }] },
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
			id: null,
			url: "https://linkedin.com/in/janedoe",
			title: "Jane Doe",
			publishedDate: null,
			score: null,
		});
	});

	it("keeps the fields evidence reads unchanged now that the vendor capture rides alongside them", async () => {
		const company = testCompany({
			domain: "acme.com",
			name: "Acme",
			exaId: "https://exa.ai/library/organization/acme",
		});
		const result = personResult(
			{
				fullName: "Jane Doe",
				location: "New York",
				workHistory: [
					{
						title: "VP of Sales",
						companyId: "https://exa.ai/library/organization/acme",
						companyName: "Acme",
					},
				],
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
	const capture = (
		employment: {
			company: string;
			confidence: number;
			source: "exa" | "target";
		}[],
		apolloMatched: boolean,
	) => ({
		entity: {
			fullName: "Jane Doe",
			currentTitle: null,
			currentCompany: null,
			location: null,
		},
		result: {
			id: null,
			url: "https://linkedin.com/in/janedoe",
			title: "Jane Doe",
			publishedDate: null,
			score: null,
		},
		employment,
		apolloMatched,
	});

	it("names the provider that produced the capture", () => {
		const data = toPersonData(
			capture([{ company: "Acme", confidence: 1, source: "exa" }], false),
			"exa",
		);

		expect(data.provider).toBe("exa");
	});

	it("keeps the free corroboration Apollo gave, rather than discarding it", () => {
		const data = toPersonData(
			capture([{ company: "Acme", confidence: 1, source: "exa" }], true),
			"exa",
		);

		expect(data.apolloMatched).toBe(true);
	});

	it("records full confidence for a person whose current role names the company", () => {
		const data = toPersonData(
			capture([{ company: "Acme", confidence: 1, source: "exa" }], false),
			"exa",
		);

		expect(data.confidence).toBe(1);
	});

	it("records the doubt when the person's employer disagrees with the company searched", () => {
		const data = toPersonData(
			capture(
				[
					{ company: "Other Co", confidence: 1, source: "exa" },
					{ company: "Acme", confidence: 0.4, source: "target" },
				],
				false,
			),
			"exa",
		);

		expect(data.confidence).toBe(0.4);
		expect(data.employment).toHaveLength(2);
	});
});

async function unitSource(): Promise<string> {
	const core = await rawSource("../src/core/people/index.ts");
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

describe("a domain list resolves to the companies of one profile", () => {
	const match = (domain: string, icpId: string, id: string) => ({
		id,
		domain,
		name: domain,
		icpId,
		exaId: null,
	});

	it("drops a company that matches the domain under a different profile", () => {
		const result = companiesOfOneProfile(
			[
				match("shared.com", "icp-a", "company-a"),
				match("shared.com", "icp-b", "company-b"),
			],
			["shared.com"],
		);

		expect(result.icpId).toBe("icp-a");
		expect(result.companies.map((row) => row.id)).toEqual(["company-a"]);
	});

	it("reports a domain found only under another profile as unmatched", () => {
		const result = companiesOfOneProfile(
			[
				match("mine.com", "icp-a", "company-a"),
				match("theirs.com", "icp-b", "company-b"),
			],
			["mine.com", "theirs.com"],
		);

		expect(result.companies.map((row) => row.domain)).toEqual(["mine.com"]);
		expect(result.unknownDomains).toEqual(["theirs.com"]);
	});

	it("keeps every company when they all belong to one profile", () => {
		const result = companiesOfOneProfile(
			[
				match("one.com", "icp-a", "company-1"),
				match("two.com", "icp-a", "company-2"),
			],
			["one.com", "two.com"],
		);

		expect(result.companies).toHaveLength(2);
		expect(result.unknownDomains).toEqual([]);
	});
});
