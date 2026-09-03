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
import { findRun, openRun } from "../src/core/db/queries";
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

describe("runOneCompany: an unresolved domain's Clay spend", () => {
	it("banks the identity step's clay records and spend on the run_company row", async () => {
		const domain = `unresolved-spend-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-unresolved-spend-${crypto.randomUUID()}`,
			"people workflow unresolved spend test",
		);
		const runId = `people_unresolved_spend_${crypto.randomUUID()}`;
		try {
			await openRun(testEnv, {
				id: runId,
				organizationId: org.id,
				icpId: null,
				capability: "people",
				status: "running",
			});

			const ctx: CompanyLoopContext = {
				env: { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } },
				step: fakeWorkflowStep(
					new Map([
						[
							`people-${domain}-identity`,
							{
								how: "unresolved",
								clayRecords: 7,
								costEntries: [
									{ provider: "clay", op: "search", dollars: 0.03 },
								],
							},
						],
					]),
				),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.unresolvedDomain).toBe(domain);
			expect(result.costDollars).toBeCloseTo(0.03);

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
			expect(runCompanyRows[0]?.clayRecords).toBe(7);
			expect(runCompanyRows[0]?.spendDollars).toBeCloseTo(0.03);
		} finally {
			await cleanupTargetRun(org.id, runId);
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

function orderedStep(
	overrides: Map<string, unknown>,
	events: string[],
): WorkflowStep {
	async function runNamed(
		name: string,
		second: unknown,
		third: unknown,
	): Promise<unknown> {
		events.push(`start:${name}`);
		await Promise.resolve();
		try {
			if (overrides.has(name)) {
				const value = overrides.get(name);
				if (value instanceof Error) throw value;
				return value;
			}
			const callback = typeof second === "function" ? second : third;
			if (typeof callback !== "function") {
				throw new Error(`ordered step: no callback for ${name}`);
			}
			const ctx: WorkflowStepContext = {
				step: { name, count: 0 },
				attempt: 1,
				config: {},
			};
			return await callback(ctx);
		} finally {
			events.push(`end:${name}`);
		}
	}
	return {
		do: runNamed,
		sleep: async () => undefined,
		sleepUntil: async () => undefined,
		waitForEvent: async () => {
			throw new Error("ordered step: waitForEvent not implemented");
		},
	};
}

function eventIndex(events: string[], label: string): number {
	const index = events.indexOf(label);
	if (index === -1) throw new Error(`event never recorded: ${label}`);
	return index;
}

function rosterModeOverrides(
	domain: string,
	index: number,
): [string, unknown][] {
	return [
		[`people-${domain}-open`, `rc-${index}`],
		[
			`people-${domain}-identity`,
			{
				how: "domain",
				identifier: domain,
				name: `Company ${index}`,
				clayRecords: 0,
				costEntries: [],
			},
		],
		[`people-${domain}-create-company`, `company-${index}`],
		[
			`people-${domain}-roster`,
			{ candidates: [], clayRecords: 0, costEntries: [] },
		],
		[`people-${domain}-save`, { count: 0 }],
	];
}

function unresolvedModeOverrides(
	domain: string,
	index: number,
): [string, unknown][] {
	return [
		[`people-${domain}-open`, `rc-${index}`],
		[
			`people-${domain}-identity`,
			{ how: "unresolved", clayRecords: 0, costEntries: [] },
		],
		[`people-${domain}-unresolved`, {}],
	];
}

describe("runCompanies: batching by companyConcurrency", () => {
	it("runs twelve companies as three batches of five, overlapping within a batch but never across a batch boundary, and reports the summary in request order", async () => {
		const domains = Array.from(
			{ length: 12 },
			(_, i) => `batch-order-${i}.example`,
		);
		const unresolvedIndexes = new Set([1, 3]);
		const overrides = new Map<string, unknown>();
		for (const [i, domain] of domains.entries()) {
			const pairs = unresolvedIndexes.has(i)
				? unresolvedModeOverrides(domain, i)
				: rosterModeOverrides(domain, i);
			for (const [name, value] of pairs) overrides.set(name, value);
			overrides.set(`people-${domain}-spend`, { total: 0 });
		}

		const events: string[] = [];
		const ctx: CompanyLoopContext = {
			env: testEnv,
			step: orderedStep(overrides, events),
			runId: "batch-order-run",
			organizationId: "org-1",
			buyer: resolveBuyer({ target: null, profile: null }),
			profile: null,
		};

		const result = await runCompanies(ctx, domains.map(bareCompany), 0);

		expect(result.companiesSearched).toBe(12);
		expect(result.unknownDomains).toEqual([domains[1], domains[3]]);

		const firstBatchSpendEnds = domains
			.slice(0, 5)
			.map((domain) => eventIndex(events, `end:people-${domain}-spend`));
		const secondBatchStart = eventIndex(
			events,
			`start:people-${domains[5]}-open`,
		);
		expect(secondBatchStart).toBeGreaterThan(Math.max(...firstBatchSpendEnds));

		const secondCompanyOpenStart = eventIndex(
			events,
			`start:people-${domains[1]}-open`,
		);
		const firstCompanySpendEnd = eventIndex(
			events,
			`end:people-${domains[0]}-spend`,
		);
		expect(secondCompanyOpenStart).toBeLessThan(firstCompanySpendEnd);
	});
});

describe("runCompanies: the per-run spend ceiling checked between batches", () => {
	it("lets a batch already started finish, banks every one of its companies' spend, then caps before the next batch starts", async () => {
		const concurrency = config.people.companyConcurrency;
		const domains = Array.from(
			{ length: concurrency + 1 },
			(_, i) => `batch-cap-${i}.example`,
		);
		const perCompanySpend = (config.spend.perRunDollars / concurrency) * 1.5;
		const overrides = new Map<string, unknown>();
		for (const [i, domain] of domains.slice(0, concurrency).entries()) {
			for (const [name, value] of rosterModeOverrides(domain, i)) {
				overrides.set(name, value);
			}
			overrides.set(`people-${domain}-spend`, { total: perCompanySpend });
		}
		const lastDomain = domains[concurrency];
		overrides.set(
			`people-${lastDomain}-open`,
			new NonRetryableError(
				"a run at the spend ceiling must never start the next batch",
			),
		);

		const events: string[] = [];
		const ctx: CompanyLoopContext = {
			env: testEnv,
			step: orderedStep(overrides, events),
			runId: "batch-cap-run",
			organizationId: "org-1",
			buyer: resolveBuyer({ target: null, profile: null }),
			profile: null,
		};

		const result = await runCompanies(ctx, domains.map(bareCompany), 0);

		expect(result.capped).toBe(true);
		expect(result.companiesSearched).toBe(concurrency);
		expect(result.costDollars).toBeCloseTo(concurrency * perCompanySpend);
		for (const domain of domains.slice(0, concurrency)) {
			eventIndex(events, `end:people-${domain}-spend`);
		}
		expect(events).not.toContain(`start:people-${lastDomain}-open`);
	});
});

type InterleaveCompany = {
	domain: string;
	name: string;
	clayRecords: number;
	rosterDollars: number;
	candidate: typeof rosterCandidate;
};

function batchInterleaveOverrides(
	company: InterleaveCompany,
): [string, unknown][] {
	const { domain, name, clayRecords, rosterDollars, candidate } = company;
	return [
		[
			`people-${domain}-identity`,
			{
				how: "domain",
				identifier: domain,
				name,
				clayRecords,
				costEntries: [{ provider: "clay", op: "search", dollars: 0.02 }],
			},
		],
		[
			`people-${domain}-roster`,
			{
				candidates: [candidate],
				clayRecords,
				costEntries: [
					{ provider: "clay", op: "search", dollars: rosterDollars },
				],
			},
		],
	];
}

describe("runCompanies: two companies sharing a batch", () => {
	it("keeps its own run_company row, roster count, and banked spend for each company", async () => {
		const domainA = `batch-interleave-a-${crypto.randomUUID()}.example`;
		const domainB = `batch-interleave-b-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-batch-interleave-${crypto.randomUUID()}`,
			"people workflow batch interleave test",
		);
		const runId = `people_batch_interleave_${crypto.randomUUID()}`;
		try {
			await openRun(testEnv, {
				id: runId,
				organizationId: org.id,
				icpId: null,
				capability: "people",
				status: "running",
			});
			const candidateA = {
				...rosterCandidate,
				name: "Avery A",
				url: "https://linkedin.com/in/avery-a-batch",
			};
			const candidateB = {
				...rosterCandidate,
				name: "Blair B",
				url: "https://linkedin.com/in/blair-b-batch",
			};
			const overrides = new Map<string, unknown>([
				...batchInterleaveOverrides({
					domain: domainA,
					name: "Batch Co A",
					clayRecords: 2,
					rosterDollars: 0.03,
					candidate: candidateA,
				}),
				...batchInterleaveOverrides({
					domain: domainB,
					name: "Batch Co B",
					clayRecords: 4,
					rosterDollars: 0.05,
					candidate: candidateB,
				}),
			]);

			const events: string[] = [];
			const ctx: CompanyLoopContext = {
				env: testEnv,
				step: orderedStep(overrides, events),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: null, profile: null }),
				profile: null,
			};

			const result = await runCompanies(
				ctx,
				[bareCompany(domainA), bareCompany(domainB)],
				0,
			);

			expect(result.companiesSearched).toBe(2);
			expect(result.peopleRoster).toBe(2);
			expect(eventIndex(events, `start:people-${domainB}-open`)).toBeLessThan(
				eventIndex(events, `end:people-${domainA}-spend`),
			);

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
			expect(runCompanyRows).toHaveLength(2);
			const rowA = runCompanyRows.find((row) => row.domain === domainA);
			const rowB = runCompanyRows.find((row) => row.domain === domainB);
			if (!rowA || !rowB) throw new Error("expected one row per domain");
			expect(rowA.peopleRoster).toBe(1);
			expect(rowB.peopleRoster).toBe(1);
			expect(rowA.spendDollars).toBeCloseTo(0.05);
			expect(rowB.spendDollars).toBeCloseTo(0.07);
			expect(result.costDollars).toBeCloseTo(
				(rowA.spendDollars ?? 0) + (rowB.spendDollars ?? 0),
			);
		} finally {
			await cleanupTargetRun(org.id, runId);
		}
	});
});

describe("FindPeopleWorkflow: a step that throws after the run opens", () => {
	it("leaves the run row errored, with finished_at set, instead of running forever", async () => {
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-close-errored-${crypto.randomUUID()}`,
			"people workflow close errored test",
		);
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
					{
						companies: [bareCompany(domain)],
						icpId: null,
						unknownDomains: [],
					},
				);
				await m.mockStepResult({ name: `people-${domain}-open` }, "rc-1");
				await m.mockStepError(
					{ name: `people-${domain}-identity` },
					new NonRetryableError(
						"a step failure must close the run, not leave it running",
					),
				);
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
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection.delete(run).where(eq(run.id, instanceId));
				await connection
					.delete(organization)
					.where(eq(organization.id, org.id));
			});
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
		const personRows = await connection
			.select()
			.from(person)
			.where(eq(person.organizationId, organizationId));
		const evidenceSubjectIds = [
			...runCompanyRows.map((row) => row.id),
			...personRows.map((row) => row.id),
		];
		if (evidenceSubjectIds.length > 0) {
			await connection
				.delete(evidence)
				.where(inArray(evidence.subjectId, evidenceSubjectIds));
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
		if (overrides.has(name)) {
			const value = overrides.get(name);
			if (value instanceof Error) throw value;
			return value;
		}
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
		[
			`people-${domain}-verify-0-quote`,
			{ found: true, reason: "found", costEntries: [] },
		],
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
	const jordanBlake = storedPeople.find(
		(row: Person) => row.linkedinUrl === "https://linkedin.com/in/jordan-blake",
	);
	if (!jordanBlake) throw new Error("expected jordan blake to be verified");
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
		1,
	);
	expect(kinds.filter((kind: string) => kind === "verify-poll")).toHaveLength(
		1,
	);
	expect(kinds.filter((kind: string) => kind === "verify-quote")).toHaveLength(
		0,
	);

	const personEvidenceRows = await withConnection(
		testEnv,
		"direct",
		db,
		(connection) =>
			connection
				.select()
				.from(evidence)
				.where(eq(evidence.subjectId, jordanBlake.id)),
	);
	const personKinds = personEvidenceRows.map((row: Evidence) => row.kind);
	expect(
		personKinds.filter((kind: string) => kind === "verify-start"),
	).toHaveLength(1);
	expect(
		personKinds.filter((kind: string) => kind === "verify-poll"),
	).toHaveLength(1);
	const quoteRows = personEvidenceRows.filter(
		(row: Evidence) => row.kind === "verify-quote",
	);
	expect(quoteRows).toHaveLength(1);
	expect(JSON.parse(quoteRows[0]?.value ?? "")).toEqual({
		runCompanyId: runCompanyRow.id,
		body: {
			url: "https://verifytarget.example/team",
			found: true,
			reason: "found",
		},
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

function pollErrorRunOverrides(domain: string): Map<string, unknown> {
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
			new NonRetryableError("verify agent run exhausted its poll budget"),
		],
		[`people-${domain}-verify-1-start`, { id: "agent-run-1" }],
		[
			`people-${domain}-verify-1-poll-1`,
			{
				run: { status: "completed", output: CONFIRMED_VERDICT },
				costEntries: [],
			},
		],
		[
			`people-${domain}-verify-1-quote`,
			{ found: true, reason: "found", costEntries: [] },
		],
	]);
}

describe("FindPeopleWorkflow: a pick whose poll step fails", () => {
	it("drops that pick, keeps the company's other picks, and lets the run continue to the next company", async () => {
		const domainA = `poll-error-a-${crypto.randomUUID()}.example`;
		const domainB = `poll-error-b-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-poll-error-${crypto.randomUUID()}`,
			"people workflow poll error test",
		);
		const runId = `people_poll_error_${crypto.randomUUID()}`;
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

			const overrides = new Map<string, unknown>([
				...pollErrorRunOverrides(domainA),
				[
					`people-${domainB}-select`,
					{ picks: [], droppedIds: [], reply: { picks: [] }, costDollars: 0 },
				],
			]);

			const ctx: CompanyLoopContext = {
				env: { ...testEnv, CLAY_API_KEY: { get: async () => "test-clay-key" } },
				step: fakeWorkflowStep(overrides),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runCompanies(
				ctx,
				[bareCompany(domainA), bareCompany(domainB)],
				0,
			);

			expect(result.companiesSearched).toBe(2);
			expect(result.peopleVerified).toBe(1);

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
			const domainARow = runCompanyRows.find((row) => row.domain === domainA);
			if (!domainARow) {
				throw new Error("expected a run_company row for the failing domain");
			}
			const evidenceRows = await withConnection(
				testEnv,
				"direct",
				db,
				(connection) =>
					connection
						.select()
						.from(evidence)
						.where(eq(evidence.subjectId, domainARow.id)),
			);
			expect(evidenceRows.some((row) => row.kind === "verify-error")).toBe(
				true,
			);
		} finally {
			await cleanupTargetRun(org.id, runId);
		}
	});
});

const UNKNOWN_VERDICT_WITH_URL = {
	verdict: "UNKNOWN",
	evidence_url: "https://verifytarget.example/unclear",
	evidence_quote: "an ambiguous mention of the role",
	evidence_kind: null,
	confidence: 0.3,
};

function unknownVerdictWithUrlOverrides(domain: string): Map<string, unknown> {
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
				run: { status: "completed", output: UNKNOWN_VERDICT_WITH_URL },
				costEntries: [],
			},
		],
	]);
}

async function evidenceRowsForRun(runId: string): Promise<Evidence[]> {
	const runCompanyRows = await withConnection(
		testEnv,
		"direct",
		db,
		(connection) =>
			connection.select().from(runCompany).where(eq(runCompany.runId, runId)),
	);
	const runCompanyRow = runCompanyRows[0];
	if (!runCompanyRow) throw new Error("expected a run_company row");
	return withConnection(testEnv, "direct", db, (connection) =>
		connection
			.select()
			.from(evidence)
			.where(eq(evidence.subjectId, runCompanyRow.id)),
	);
}

describe("FindPeopleWorkflow: an unknown verdict's reported URL", () => {
	it("keeps the agent's reported evidence_url on the stored verdict even though the pick is not verified", async () => {
		const domain = `unknown-url-${crypto.randomUUID()}.example`;
		const org = await organizationForSlug(
			testEnv,
			`people-workflow-unknown-url-${crypto.randomUUID()}`,
			"people workflow unknown url test",
		);
		const runId = `people_unknown_url_${crypto.randomUUID()}`;
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
				step: fakeWorkflowStep(unknownVerdictWithUrlOverrides(domain)),
				runId,
				organizationId: org.id,
				buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
				profile: null,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);
			expect(result.outcome.verified).toBe(0);

			const evidenceRows = await evidenceRowsForRun(runId);
			const pollRow = evidenceRows.find((row) => row.kind === "verify-poll");
			if (!pollRow) throw new Error("expected a verify-poll evidence row");
			expect(JSON.parse(pollRow.value ?? "").evidence_url).toBe(
				UNKNOWN_VERDICT_WITH_URL.evidence_url,
			);
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
			if (!agreeRow) throw new Error("expected verify-agree evidence");
			expect(JSON.parse(agreeRow.value)).toEqual({
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
