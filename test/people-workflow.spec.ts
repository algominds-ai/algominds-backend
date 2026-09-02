import { introspectWorkflowInstance } from "cloudflare:test";
import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { config } from "../src/config";
import { organization } from "../src/core/db/auth-schema";
import { db, withConnection } from "../src/core/db/client";
import { organizationForSlug } from "../src/core/db/organizations";
import { openRun } from "../src/core/db/queries";
import type { Evidence, Person } from "../src/core/db/schema";
import {
	company,
	evidence,
	person,
	run,
	runCompany,
} from "../src/core/db/schema";
import { resolveBuyer } from "../src/core/people/buyer";
import { clampCompanies } from "../src/workflows/find-people";
import type { CompanyLoopContext } from "../src/workflows/find-people-company";
import {
	runCompanies,
	runOneCompany,
} from "../src/workflows/find-people-company";
import type { TargetCompany } from "../src/workflows/find-people-target";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const SCOPES = [
	"people_workflow_unresolved_test",
	"people_workflow_roster_test",
	"people_workflow_spend_cap_test",
];

async function terminateStartedRuns(): Promise<void> {
	for (const scope of SCOPES) {
		const instance = await testEnv.FIND_PEOPLE.get(scope).catch(() => null);
		await instance?.terminate().catch(() => undefined);
	}
}

afterEach(terminateStartedRuns);

type StepMocker = {
	mockStepResult: (step: { name: string }, value: unknown) => Promise<void>;
	mockStepError: (step: { name: string }, error: Error) => Promise<void>;
};

function bareCompany(domain: string): TargetCompany {
	return { id: null, domain, name: null, linkedinUrl: null, icpId: null };
}

async function mockRunLevel(
	m: StepMocker,
	companies: TargetCompany[],
): Promise<void> {
	await m.mockStepResult(
		{ name: "load-companies" },
		{ companies, icpId: null, unknownDomains: [] },
	);
	await m.mockStepResult({ name: "open-run" }, { alreadySpent: 0 });
	await m.mockStepResult({ name: "close-run" }, { closed: true });
}

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
				await mockRunLevel(m, [bareCompany(domain)]);
				await m.mockStepResult({ name: `people-${domain}-open` }, "rc-1");
				await m.mockStepResult(
					{ name: `people-${domain}-identity` },
					{ how: "unresolved", clayRecords: 0, costEntries: [] },
				);
				await m.mockStepResult({ name: `people-${domain}-unresolved` }, {});
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
			expect(output.peopleVerified).toBe(0);
			expect(output.costDollars).toBe(0);
			expect(output.capped).toBe(false);
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
				await mockRunLevel(m, [bareCompany(domain)]);
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
					{ candidates: [rosterCandidate], clayRecords: 5, costEntries: [] },
				);
				await m.mockStepResult({ name: `people-${domain}-save` }, { count: 1 });
				await m.mockStepResult(
					{ name: `people-${domain}-spend` },
					{ total: 0 },
				);
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
			expect(output.costDollars).toBe(0);
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

describe("FindPeopleWorkflow: the run spend ceiling", () => {
	it("stops before new work at the spend ceiling", async () => {
		const domainA = "spend-a.example";
		const domainB = "spend-b.example";
		const instanceId = "people_workflow_spend_cap_test";
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_PEOPLE,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await mockRunLevel(m, [bareCompany(domainA), bareCompany(domainB)]);
				await m.mockStepResult({ name: `people-${domainA}-open` }, "rc-a");
				await m.mockStepResult(
					{ name: `people-${domainA}-identity` },
					{
						how: "domain",
						identifier: domainA,
						name: "Spend A",
						clayRecords: 1,
						costEntries: [],
					},
				);
				await m.mockStepResult(
					{ name: `people-${domainA}-create-company` },
					"company-a",
				);
				await m.mockStepResult(
					{ name: `people-${domainA}-roster` },
					{ candidates: [rosterCandidate], clayRecords: 5, costEntries: [] },
				);
				await m.mockStepResult(
					{ name: `people-${domainA}-save` },
					{ count: 1 },
				);
				await m.mockStepResult(
					{ name: `people-${domainA}-spend` },
					{ total: config.spend.perRunDollars },
				);
				await m.mockStepError(
					{ name: `people-${domainB}-open` },
					new NonRetryableError(
						"a run at the spend ceiling must never touch the next domain",
					),
				);
			});

			await testEnv.FIND_PEOPLE.create({
				id: instanceId,
				params: { domains: [domainA, domainB], organizationId: "org-1" },
			});
			await instance.waitForStatus("complete");

			const output = await summaryOf(instance);
			expect(output.capped).toBe(true);
			expect(output.companiesSearched).toBe(1);
			expect(output.costDollars).toBe(config.spend.perRunDollars);
		} finally {
			await instance.dispose();
		}
	});
});

const CLAY_HEADERS = { "content-type": "application/json" };

function clayResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: CLAY_HEADERS,
	});
}

function stubClayFetch(
	rows: {
		name: string;
		url: string;
		title: string;
		company: string;
	}[],
): void {
	let call = 0;
	globalThis.fetch = async (input) => {
		call += 1;
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			return clayResponse({ search_id: `search-${call}` });
		}
		return clayResponse({
			data: rows.map((row) => ({
				name: row.name,
				url: row.url,
				latest_experience_title: row.title,
				latest_experience_company: row.company,
				latest_experience_start_date: null,
				location: null,
			})),
			has_more: false,
			period_quota: { used: rows.length },
		});
	};
}

async function cleanupTargetRun(
	organizationId: string,
	runId: string,
): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		const runCompanyRows = await connection
			.select()
			.from(runCompany)
			.where(eq(runCompany.runId, runId));
		const runCompanyIds = runCompanyRows.map((row) => row.id);
		if (runCompanyIds.length > 0) {
			await connection
				.delete(evidence)
				.where(inArray(evidence.subjectId, runCompanyIds));
		}
		await connection
			.delete(person)
			.where(eq(person.organizationId, organizationId));
		await connection.delete(runCompany).where(eq(runCompany.runId, runId));
		await connection
			.delete(company)
			.where(eq(company.organizationId, organizationId));
		await connection.delete(run).where(eq(run.id, runId));
		await connection
			.delete(organization)
			.where(eq(organization.id, organizationId));
	});
}

const CONFIRMED_VERDICT = {
	verdict: "CONFIRMED",
	evidence_url: "https://verifytarget.example/team",
	evidence_quote: "Jordan Blake leads sales as VP Sales.",
	evidence_kind: "first_party",
	confidence: 0.9,
};

const UNKNOWN_VERDICT = {
	verdict: "UNKNOWN",
	evidence_url: null,
	evidence_quote: null,
	evidence_kind: null,
	confidence: 0.1,
};

const CONTRADICTED_VERDICT = {
	verdict: "CONTRADICTED",
	evidence_url: null,
	evidence_quote: null,
	evidence_kind: null,
	confidence: 0.2,
};

const AGGREGATOR_CONFIRMED_VERDICT = {
	verdict: "CONFIRMED",
	evidence_url: "https://peoplesite.example/jordan-blake",
	evidence_quote: "Jordan Blake — VP Sales",
	evidence_kind: "aggregator",
	confidence: 0.5,
};

function targetCandidate(
	id: number,
	name: string,
	title: string,
	url: string,
): {
	id: number;
	name: string;
	title: string;
	company: string;
	url: string;
	location: null;
	since: null;
	seenBy: string[];
} {
	return {
		id,
		name,
		title,
		company: "Verify Target Co",
		url,
		location: null,
		since: null,
		seenBy: ["clay:c-suite"],
	};
}

function fakeWorkflowStep(overrides: Map<string, unknown>): WorkflowStep {
	async function runNamed(
		name: string,
		second: unknown,
		third: unknown,
	): Promise<unknown> {
		if (overrides.has(name)) return overrides.get(name);
		const callback = typeof second === "function" ? second : third;
		if (typeof callback !== "function") {
			throw new Error(`fake step: no callback for ${name}`);
		}
		const ctx: WorkflowStepContext = {
			step: { name, count: 0 },
			attempt: 1,
			config: {},
		};
		return callback(ctx);
	}
	return {
		do: runNamed,
		sleep: async () => undefined,
		sleepUntil: async () => undefined,
		waitForEvent: async () => {
			throw new Error("fake step: waitForEvent not implemented");
		},
	};
}

function targetRunOverrides(domain: string): Map<string, unknown> {
	return new Map<string, unknown>([
		[
			`people-${domain}-select`,
			{
				picks: [
					{
						candidate: targetCandidate(
							0,
							"Jordan Blake",
							"VP Sales",
							"https://linkedin.com/in/jordan-blake",
						),
						basis: "explicit_persona_match",
					},
					{
						candidate: targetCandidate(
							1,
							"Casey Doe",
							"Director Sales",
							"https://linkedin.com/in/casey-doe",
						),
						basis: "inferred_workflow_owner",
					},
				],
				droppedIds: [],
				reply: { picks: [{ id: 0, basis: "explicit_persona_match" }] },
				costDollars: 0.01,
			},
		],
		[`people-${domain}-verify-0-start`, { id: "agent-run-0" }],
		[
			`people-${domain}-verify-0-poll-1`,
			{
				run: { status: "completed", output: CONFIRMED_VERDICT },
				costEntries: [],
			},
		],
		[`people-${domain}-verify-0-quote`, { found: true, reason: "found" }],
		[`people-${domain}-verify-1-start`, { id: "agent-run-1" }],
		[
			`people-${domain}-verify-1-poll-1`,
			{
				run: { status: "completed", output: UNKNOWN_VERDICT },
				costEntries: [],
			},
		],
	]);
}

async function assertVerifiedTargetRun(
	organizationId: string,
	runId: string,
): Promise<void> {
	const storedPeople = await withConnection(
		testEnv,
		"direct",
		db,
		(connection) =>
			connection
				.select()
				.from(person)
				.where(eq(person.organizationId, organizationId)),
	);
	expect(
		storedPeople.filter(
			(row: Person) =>
				row.linkedinUrl === "https://linkedin.com/in/jordan-blake",
		),
	).toHaveLength(1);
	expect(
		storedPeople.some(
			(row: Person) => row.linkedinUrl === "https://linkedin.com/in/casey-doe",
		),
	).toBe(false);

	const runCompanyRows = await withConnection(
		testEnv,
		"direct",
		db,
		(connection) =>
			connection.select().from(runCompany).where(eq(runCompany.runId, runId)),
	);
	const runCompanyRow = runCompanyRows[0];
	if (!runCompanyRow) throw new Error("expected a run_company row");

	const evidenceRows = await withConnection(
		testEnv,
		"direct",
		db,
		(connection) =>
			connection
				.select()
				.from(evidence)
				.where(eq(evidence.subjectId, runCompanyRow.id)),
	);
	const kinds = evidenceRows.map((row: Evidence) => row.kind);
	expect(kinds.filter((kind: string) => kind === "identity")).toHaveLength(2);
	expect(kinds.filter((kind: string) => kind === "roster")).toHaveLength(16);
	expect(kinds).toContain("select");
	expect(kinds.filter((kind: string) => kind === "verify-start")).toHaveLength(
		2,
	);
	expect(kinds.filter((kind: string) => kind === "verify-poll")).toHaveLength(
		2,
	);
	const quoteRows = evidenceRows.filter(
		(row: Evidence) => row.kind === "verify-quote",
	);
	expect(quoteRows).toHaveLength(1);
	expect(JSON.parse(quoteRows[0]?.value ?? "")).toEqual({
		url: "https://verifytarget.example/team",
		found: true,
		reason: "found",
	});
}

describe("FindPeopleWorkflow: a target run", () => {
	it("stores only verified target picks and all replies", async () => {
		const domain = `verify-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-verify-${crypto.randomUUID()}`,
			"people workflow verify test",
		);
		const runId = `people_verify_${crypto.randomUUID()}`;
		try {
			await openRun(testEnv, {
				id: runId,
				organizationId: org.id,
				icpId: null,
				capability: "people",
				status: "running",
			});
			stubClayFetch([
				{
					name: "Jordan Blake",
					url: "https://linkedin.com/in/jordan-blake",
					title: "VP Sales",
					company: "Verify Target Co",
				},
				{
					name: "Casey Doe",
					url: "https://linkedin.com/in/casey-doe",
					title: "Director Sales",
					company: "Verify Target Co",
				},
			]);

			const ctx: CompanyLoopContext = {
				env: { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } },
				step: fakeWorkflowStep(targetRunOverrides(domain)),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(1);
			expect(result.outcome.roster).toBe(0);
			expect(result.outcome.unresolvedDomain).toBeNull();

			await assertVerifiedTargetRun(org.id, runId);
		} finally {
			await cleanupTargetRun(org.id, runId);
		}
	});
});

function contradictedRunOverrides(domain: string): Map<string, unknown> {
	return new Map<string, unknown>([
		[
			`people-${domain}-select`,
			{
				picks: [
					{
						candidate: targetCandidate(
							0,
							"Jordan Blake",
							"VP Sales",
							"https://linkedin.com/in/jordan-blake",
						),
						basis: "explicit_persona_match",
					},
				],
				droppedIds: [],
				reply: { picks: [{ id: 0, basis: "explicit_persona_match" }] },
				costDollars: 0.01,
			},
		],
		[`people-${domain}-verify-0-start`, { id: "agent-run-0" }],
		[
			`people-${domain}-verify-0-poll-1`,
			{
				run: { status: "completed", output: CONTRADICTED_VERDICT },
				costEntries: [],
			},
		],
	]);
}

describe("FindPeopleWorkflow: a contradicted verdict", () => {
	it("stores no person for a candidate the agent contradicts", async () => {
		const domain = `contradicted-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-contradicted-${crypto.randomUUID()}`,
			"people workflow contradicted test",
		);
		const runId = `people_contradicted_${crypto.randomUUID()}`;
		try {
			await openRun(testEnv, {
				id: runId,
				organizationId: org.id,
				icpId: null,
				capability: "people",
				status: "running",
			});
			stubClayFetch([
				{
					name: "Jordan Blake",
					url: "https://linkedin.com/in/jordan-blake",
					title: "VP Sales",
					company: "Verify Target Co",
				},
			]);

			const ctx: CompanyLoopContext = {
				env: { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } },
				step: fakeWorkflowStep(contradictedRunOverrides(domain)),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(0);
			const storedPeople = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(person)
						.where(eq(person.organizationId, org.id)),
			);
			expect(storedPeople).toHaveLength(0);
		} finally {
			await cleanupTargetRun(org.id, runId);
		}
	});
});

function stubClayRejectFetch(): { runCalls: number } {
	const calls = { runCalls: 0 };
	globalThis.fetch = async (input) => {
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			return clayResponse({ search_id: "search-rejected" });
		}
		calls.runCalls += 1;
		return new Response(
			JSON.stringify({ error: "invalid company_identifier" }),
			{ status: 400, headers: CLAY_HEADERS },
		);
	};
	return calls;
}

describe("FindPeopleWorkflow: a Clay-rejected domain", () => {
	it("writes identity: unresolved and lists the domain as unknown, with no roster call", async () => {
		const domain = "notacompany.example";
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-reject-${crypto.randomUUID()}`,
			"people workflow reject test",
		);
		const runId = `people_reject_${crypto.randomUUID()}`;
		try {
			await openRun(testEnv, {
				id: runId,
				organizationId: org.id,
				icpId: null,
				capability: "people",
				status: "running",
			});
			const calls = stubClayRejectFetch();

			const ctx: CompanyLoopContext = {
				env: { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } },
				step: fakeWorkflowStep(new Map()),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runCompanies(ctx, [bareCompany(domain)], 0);

			expect(result.unknownDomains).toEqual([domain]);
			expect(result.companiesSearched).toBe(1);
			expect(result.peopleVerified).toBe(0);
			expect(result.peopleRoster).toBe(0);
			expect(calls.runCalls).toBe(1);

			const runCompanyRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(runCompany)
						.where(eq(runCompany.runId, runId)),
			);
			expect(runCompanyRows).toHaveLength(1);
			expect(runCompanyRows[0]?.identity).toBe("unresolved");
			expect(runCompanyRows[0]?.companyId).toBeNull();

			const companyRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(company)
						.where(eq(company.organizationId, org.id)),
			);
			expect(companyRows).toHaveLength(0);
		} finally {
			await cleanupTargetRun(org.id, runId);
		}
	});
});

function wrongCompanyRunOverrides(domain: string): Map<string, unknown> {
	return new Map<string, unknown>([
		[
			`people-${domain}-select`,
			{
				picks: [
					{
						candidate: targetCandidate(
							0,
							"Jordan Blake",
							"VP Sales",
							"https://linkedin.com/in/jordan-blake",
						),
						basis: "explicit_persona_match",
					},
				],
				droppedIds: [],
				reply: { picks: [{ id: 0, basis: "explicit_persona_match" }] },
				costDollars: 0.01,
			},
		],
		[`people-${domain}-verify-0-start`, { id: "agent-run-0" }],
		[
			`people-${domain}-verify-0-poll-1`,
			{
				run: { status: "completed", output: AGGREGATOR_CONFIRMED_VERDICT },
				costEntries: [],
			},
		],
		[
			`people-${domain}-verify-0-index`,
			{
				found: true,
				employer: "A Totally Different Company",
				reply: "{}",
				costEntries: [],
			},
		],
		[
			`people-${domain}-verify-0-agree`,
			{
				label: "DIFFERENT",
				reply: { employer: "DIFFERENT" },
				costEntries: [],
			},
		],
	]);
}

describe("FindPeopleWorkflow: a roster candidate who works elsewhere", () => {
	it("does not verify a candidate the second opinion says works at a different company", async () => {
		const domain = `wrong-company-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-wrong-company-${crypto.randomUUID()}`,
			"people workflow wrong company test",
		);
		const runId = `people_wrong_company_${crypto.randomUUID()}`;
		try {
			await openRun(testEnv, {
				id: runId,
				organizationId: org.id,
				icpId: null,
				capability: "people",
				status: "running",
			});
			stubClayFetch([
				{
					name: "Jordan Blake",
					url: "https://linkedin.com/in/jordan-blake",
					title: "VP Sales",
					company: "Verify Target Co",
				},
			]);

			const ctx: CompanyLoopContext = {
				env: { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } },
				step: fakeWorkflowStep(wrongCompanyRunOverrides(domain)),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(0);
			const storedPeople = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(person)
						.where(eq(person.organizationId, org.id)),
			);
			expect(storedPeople).toHaveLength(0);

			const runCompanyRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(runCompany)
						.where(eq(runCompany.runId, runId)),
			);
			const runCompanyRow = runCompanyRows[0];
			if (!runCompanyRow) throw new Error("expected a run_company row");
			const evidenceRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(evidence)
						.where(eq(evidence.subjectId, runCompanyRow.id)),
			);
			const agreeRow = evidenceRows.find((row) => row.kind === "verify-agree");
			expect(agreeRow).toBeDefined();
			expect(JSON.parse(agreeRow?.value ?? "null")).toEqual({
				employer: "DIFFERENT",
			});
		} finally {
			await cleanupTargetRun(org.id, runId);
		}
	});
});

function nullSelectRunOverrides(domain: string): Map<string, unknown> {
	return new Map<string, unknown>([
		[
			`people-${domain}-select`,
			{ picks: [], droppedIds: [], reply: null, costDollars: 0 },
		],
	]);
}

describe("FindPeopleWorkflow: a null selector reply", () => {
	it("picks nobody but still records one select evidence row", async () => {
		const domain = `null-select-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-null-select-${crypto.randomUUID()}`,
			"people workflow null select test",
		);
		const runId = `people_null_select_${crypto.randomUUID()}`;
		try {
			await openRun(testEnv, {
				id: runId,
				organizationId: org.id,
				icpId: null,
				capability: "people",
				status: "running",
			});
			stubClayFetch([
				{
					name: "Jordan Blake",
					url: "https://linkedin.com/in/jordan-blake",
					title: "VP Sales",
					company: "Verify Target Co",
				},
			]);

			const ctx: CompanyLoopContext = {
				env: { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } },
				step: fakeWorkflowStep(nullSelectRunOverrides(domain)),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(0);
			const runCompanyRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(runCompany)
						.where(eq(runCompany.runId, runId)),
			);
			const runCompanyRow = runCompanyRows[0];
			if (!runCompanyRow) throw new Error("expected a run_company row");
			const evidenceRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(evidence)
						.where(eq(evidence.subjectId, runCompanyRow.id)),
			);
			const selectRows = evidenceRows.filter((row) => row.kind === "select");
			expect(selectRows).toHaveLength(1);
			expect(selectRows[0]?.value).toBe("null");
		} finally {
			await cleanupTargetRun(org.id, runId);
		}
	});
});
