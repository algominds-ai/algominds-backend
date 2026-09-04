import { env as testEnv } from "cloudflare:workers";
import type { RunReport } from "@eval/headline";
import type { CompanyTraceRecord, RoundTraceRecord } from "@eval/read";
import type { PeopleCompanyTraceRecord } from "@eval/read-people";
import {
	buildCompanyRunTrace,
	buildPeopleRunTrace,
	logTrace,
	traceCompaniesRun,
	tracePeopleRun,
} from "@eval/trace";
import { _exportsForTestingOnly } from "braintrust";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DbEnv } from "../src/core/db/client";
import { createIcp } from "../src/core/db/icp";
import { organizationForSlug } from "../src/core/db/organizations";
import { upsertPeople } from "../src/core/db/people";
import {
	appendEvidence,
	saveCompanies,
	saveRound,
} from "../src/core/db/queries";
import {
	saveRunCompanies,
	updateRunCompany,
} from "../src/core/db/run-companies";
import { closeRun, openRun } from "../src/core/db/runs";

const LoggedEventSchema = z.object({
	span_attributes: z.object({ name: z.string().optional() }).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

function loggedEventName(event: unknown): string | undefined {
	return LoggedEventSchema.safeParse(event).data?.span_attributes?.name;
}

function loggedEventMetadata(
	event: unknown,
): z.infer<typeof LoggedEventSchema>["metadata"] {
	return LoggedEventSchema.safeParse(event).data?.metadata;
}

function fakeEnv(url: string): DbEnv {
	return {
		HYPERDRIVE_CACHED: { connectionString: url },
		HYPERDRIVE_DIRECT: { connectionString: url },
	};
}

function run(overrides: Partial<RunReport> = {}): RunReport {
	return {
		runId: "run-1",
		costDollars: 0.42,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:02:00.000Z",
		...overrides,
	};
}

function round(overrides: Partial<RoundTraceRecord> = {}): RoundTraceRecord {
	return {
		ordinal: 1,
		plans: [
			{
				query: "fintechs hiring a head of onboarding",
				angle: "neobanks",
				source: "exa-search",
				countries: ["US"],
				minWorkforce: 50,
				maxWorkforce: null,
			},
		],
		route: "exa-search",
		funnel: {
			returned: 5,
			inBounds: 4,
			gated: 2,
			judgedKept: 1,
			judgedRefused: 1,
		},
		startedAt: "2026-01-01T00:00:00.000Z",
		seconds: 30,
		...overrides,
	};
}

function company(
	overrides: Partial<CompanyTraceRecord> = {},
): CompanyTraceRecord {
	return {
		domain: "good.com",
		name: "Good Co",
		industry: "software",
		description: "runs its own onboarding funnel",
		citedPage: "https://good.com/careers",
		quote: "we are hiring a head of onboarding",
		evidenceCheck: "found",
		fitReason: "matches the profile's shape",
		...overrides,
	};
}

describe("buildCompanyRunTrace", () => {
	it("names the root span and carries the run's own metadata", () => {
		const trace = buildCompanyRunTrace({
			run: run(),
			meta: { profile: "mstone", arm: "baseline", trial: 0, commit: "abc123" },
			rounds: [round()],
			refusalsByRound: new Map([
				[
					1,
					[
						{
							domain: "bad.com",
							reason: "contradicts r1",
							statuses: [{ id: "r1", status: "contradicted" }],
						},
					],
				],
			]),
			companies: [company()],
		});
		expect(trace.name).toBe("companies-run");
		expect(trace.metadata).toMatchObject({
			profile: "mstone",
			arm: "baseline",
			trial: 0,
			commit: "abc123",
			count: 1,
			costDollars: 0.42,
			seconds: 120,
		});
	});

	it("gives every round a judge child and a refused child carrying the round-refusals evidence", () => {
		const trace = buildCompanyRunTrace({
			run: run(),
			meta: { profile: "mstone", arm: "baseline", trial: 0, commit: "abc123" },
			rounds: [round()],
			refusalsByRound: new Map([
				[
					1,
					[
						{
							domain: "bad.com",
							reason: "contradicts r1",
							statuses: [{ id: "r1", status: "contradicted" }],
						},
					],
				],
			]),
			companies: [],
		});
		const roundSpan = trace.children.find((child) => child.name === "round-1");
		expect(roundSpan).toBeDefined();
		const judge = roundSpan?.children.find((child) => child.name === "judge");
		expect(judge?.output).toEqual({
			refused: [
				{
					domain: "bad.com",
					reason: "contradicts r1",
					statuses: [{ id: "r1", status: "contradicted" }],
				},
			],
		});
		const refused = roundSpan?.children.find(
			(child) => child.name === "refused",
		);
		expect(refused?.output).toEqual([
			{ domain: "bad.com", reason: "contradicts r1" },
		]);
	});

	it("gives every stored company its own span carrying the cited page, quote and fit reason", () => {
		const trace = buildCompanyRunTrace({
			run: run(),
			meta: { profile: "mstone", arm: "baseline", trial: 0, commit: "abc123" },
			rounds: [],
			refusalsByRound: new Map(),
			companies: [company()],
		});
		const companySpan = trace.children.find(
			(child) => child.name === "company-good.com",
		);
		expect(companySpan?.output).toMatchObject({
			citedPage: "https://good.com/careers",
			evidenceCheck: "found",
			fitReason: "matches the profile's shape",
		});
	});
});

function peopleCompany(
	overrides: Partial<PeopleCompanyTraceRecord> = {},
): PeopleCompanyTraceRecord {
	return {
		domain: "good.com",
		identity: "domain",
		mode: "profile",
		rosterSize: 8,
		picks: [
			{
				name: "Jamie Rivera",
				title: "Head of Onboarding",
				verified: true,
				verdict: "CONFIRMED",
				indexEmployer: "Good Co",
				agreement: "SAME",
				quoteCheck: { found: true, reason: "found" },
			},
		],
		...overrides,
	};
}

describe("buildPeopleRunTrace", () => {
	it("names the root span and gives every company a pick span with its verdict", () => {
		const trace = buildPeopleRunTrace({
			run: run(),
			meta: { profile: "mstone", arm: "baseline", trial: 0, commit: "abc123" },
			companies: [peopleCompany()],
		});
		expect(trace.name).toBe("people-run");
		const companySpan = trace.children.find(
			(child) => child.name === "company-good.com",
		);
		expect(companySpan?.output).toMatchObject({ rosterSize: 8, pickCount: 1 });
		const pick = companySpan?.children[0];
		expect(pick?.name).toBe("pick-Jamie Rivera");
		expect(pick?.output).toMatchObject({
			verified: true,
			verdict: "CONFIRMED",
			indexEmployer: "Good Co",
			agreement: "SAME",
		});
	});
});

type FixtureTracker = {
	organizationIds: string[];
	icpIds: string[];
	runIds: string[];
};

function roundFixtureRow(runId: string): Parameters<typeof saveRound>[1] {
	return {
		runId,
		ordinal: 1,
		plan: [
			{
				query: "fintechs hiring a head of onboarding",
				angle: "neobanks",
				source: "exa-search",
				countries: ["US"],
				minWorkforce: 50,
				maxWorkforce: null,
			},
		],
		found: 1,
		rejected: { filter: 0, gate: 0, judge: 1 },
		rejects: [],
	};
}

function roundRefusalsFixtureRow(
	runId: string,
): Parameters<typeof appendEvidence>[1][number] {
	return {
		subjectType: "run",
		subjectId: runId,
		kind: "round-refusals",
		source: "exa",
		value: JSON.stringify({
			round: 1,
			refused: [
				{
					domain: "bad.com",
					reason: "contradicts r1",
					statuses: [{ id: "r1", status: "contradicted" }],
				},
			],
		}),
	};
}

function companyFixtureRow(
	runId: string,
	icpId: string,
	organizationId: string,
): Parameters<typeof saveCompanies>[1][number] {
	return {
		icpId,
		organizationId,
		domain: "good.com",
		name: "Good Co",
		industry: "software",
		runId,
		data: {
			provider: "exa-search",
			entity: { description: "runs its own onboarding funnel" },
			result: {
				url: "https://good.com/careers",
				quote: "we are hiring a head of onboarding",
				evidenceCheck: "found",
				fitReason: "matches the profile's shape",
			},
		},
	};
}

async function seedCompanyRunFixture(
	env: DbEnv,
	tracker: FixtureTracker,
): Promise<string> {
	const org = await organizationForSlug(
		env,
		`eval-trace-test-org-${crypto.randomUUID()}`,
		"Eval Trace Test",
	);
	tracker.organizationIds.push(org.id);
	const icpRow = await createIcp(env, {
		organizationId: org.id,
		domain: "seller.example",
		description: "sells onboarding software",
	});
	tracker.icpIds.push(icpRow.id);
	const runId = `eval-trace-test-${crypto.randomUUID()}`;
	tracker.runIds.push(runId);
	await openRun(env, {
		id: runId,
		organizationId: org.id,
		icpId: icpRow.id,
		capability: "companies",
		status: "running",
	});
	await saveRound(env, roundFixtureRow(runId));
	await appendEvidence(env, [roundRefusalsFixtureRow(runId)]);
	await saveCompanies(env, [companyFixtureRow(runId, icpRow.id, org.id)]);
	await closeRun(env, runId, { status: "complete", costDollars: 0.42 });
	return runId;
}

async function readCompaniesTraceSpec(
	url: string,
	runId: string,
): Promise<Awaited<ReturnType<typeof traceCompaniesRun>>> {
	const sql = postgres(url, { max: 1 });
	try {
		return await traceCompaniesRun(sql, runId, {
			profile: "mstone",
			arm: "baseline",
			trial: 0,
			commit: "abc123",
		});
	} finally {
		await sql.end();
	}
}

async function assertLoggedThroughTestTransport(
	spec: Awaited<ReturnType<typeof traceCompaniesRun>>,
): Promise<void> {
	await _exportsForTestingOnly.simulateLoginForTests();
	const testLogger = _exportsForTestingOnly.useTestBackgroundLogger();
	try {
		await logTrace(spec, "test-project-id");
		const events = await testLogger.drain();
		const names = events.map(loggedEventName);
		expect(names).toEqual(
			expect.arrayContaining([
				"companies-run",
				"round-1",
				"judge",
				"refused",
				"company-good.com",
			]),
		);
		const root = events.find(
			(event) => loggedEventName(event) === "companies-run",
		);
		expect(loggedEventMetadata(root)).toMatchObject({
			profile: "mstone",
			arm: "baseline",
		});
	} finally {
		_exportsForTestingOnly.clearTestBackgroundLogger();
	}
}

async function cleanUpCompanyFixture(tracker: FixtureTracker): Promise<void> {
	const sql = postgres(testEnv.HYPERDRIVE_DIRECT.connectionString, { max: 1 });
	try {
		await sql`delete from evidence where subject_id = any(${tracker.runIds})`;
		await sql`delete from company where run_id = any(${tracker.runIds})`;
		await sql`delete from round where run_id = any(${tracker.runIds})`;
		await sql`delete from run where id = any(${tracker.runIds})`;
		if (tracker.icpIds.length > 0) {
			await sql`delete from icp where id = any(${tracker.icpIds})`;
		}
		if (tracker.organizationIds.length > 0) {
			await sql`delete from organization where id = any(${tracker.organizationIds})`;
		}
	} finally {
		await sql.end();
	}
}

describe("traceCompaniesRun + logTrace", () => {
	const tracker: FixtureTracker = {
		organizationIds: [],
		icpIds: [],
		runIds: [],
	};

	afterAll(() => cleanUpCompanyFixture(tracker));

	it("rebuilds a span tree from a fixture run and logs it through Braintrust's own transport", async () => {
		const url = testEnv.HYPERDRIVE_DIRECT.connectionString;
		const runId = await seedCompanyRunFixture(fakeEnv(url), tracker);
		const spec = await readCompaniesTraceSpec(url, runId);
		expect(spec.name).toBe("companies-run");
		expect(spec.children.map((child) => child.name)).toEqual(
			expect.arrayContaining(["round-1", "company-good.com"]),
		);
		await assertLoggedThroughTestTransport(spec);
	});
});

type PeopleFixtureTracker = {
	organizationIds: string[];
	runIds: string[];
	companyIds: string[];
	runCompanyIds: string[];
};

type PeopleFixture = { runId: string };

async function seedVerifiedPickEvidence(
	env: DbEnv,
	personId: string,
	runCompanyId: string,
): Promise<void> {
	await appendEvidence(env, [
		{
			subjectType: "person",
			subjectId: personId,
			kind: "verify-poll",
			source: "exa",
			value: JSON.stringify({
				runCompanyId,
				body: { verdict: "CONFIRMED" },
			}),
		},
		{
			subjectType: "person",
			subjectId: personId,
			kind: "verify-quote",
			source: "exa",
			value: JSON.stringify({
				runCompanyId,
				body: { url: "https://good.com/team", found: true, reason: "found" },
			}),
		},
	]);
}

async function seedPeopleRunFixture(
	env: DbEnv,
	tracker: PeopleFixtureTracker,
): Promise<PeopleFixture> {
	const org = await organizationForSlug(
		env,
		`eval-trace-people-org-${crypto.randomUUID()}`,
		"Eval Trace People",
	);
	tracker.organizationIds.push(org.id);
	const runId = `eval-trace-people-${crypto.randomUUID()}`;
	tracker.runIds.push(runId);
	await openRun(env, {
		id: runId,
		organizationId: org.id,
		icpId: null,
		capability: "people",
		status: "running",
	});
	const [runCompany] = await saveRunCompanies(env, [
		{
			runId,
			domain: "good.com",
			identity: "domain",
			mode: "profile",
			buyerSource: "captured",
			peopleRoster: 8,
		},
	]);
	if (!runCompany) throw new Error("test setup: no run_company row");
	tracker.runCompanyIds.push(runCompany.id);
	const [saved] = await saveCompanies(env, [
		{
			icpId: null,
			organizationId: org.id,
			domain: "good.com",
			name: "Good Co",
			runId,
			data: null,
		},
	]);
	if (!saved) throw new Error("test setup: no company row");
	tracker.companyIds.push(saved.id);
	await updateRunCompany(env, runCompany.id, { companyId: saved.id });
	const [person] = await upsertPeople(env, [
		{
			organizationId: org.id,
			companyId: saved.id,
			linkedinUrl: "https://linkedin.com/in/jamie-rivera",
			name: "Jamie Rivera",
			title: "Head of Onboarding",
			data: {
				status: "verified",
				basis: "explicit_persona_match",
				seenBy: ["clay:vp"],
				since: "2024-11-01",
				location: null,
			},
		},
	]);
	if (!person) throw new Error("test setup: no person row");
	await seedVerifiedPickEvidence(env, person.id, runCompany.id);
	await closeRun(env, runId, { status: "complete", costDollars: 0.1 });
	return { runId };
}

async function readPeopleTraceSpec(
	url: string,
	runId: string,
): Promise<Awaited<ReturnType<typeof tracePeopleRun>>> {
	const sql = postgres(url, { max: 1 });
	try {
		return await tracePeopleRun(sql, runId, {
			profile: "mstone",
			arm: "baseline",
			trial: 0,
			commit: "abc123",
		});
	} finally {
		await sql.end();
	}
}

async function cleanUpPeopleFixture(
	tracker: PeopleFixtureTracker,
): Promise<void> {
	const sql = postgres(testEnv.HYPERDRIVE_DIRECT.connectionString, { max: 1 });
	try {
		await sql`delete from evidence where subject_id in (select id::text from person where company_id = any(${tracker.companyIds}))`;
		await sql`delete from evidence where subject_type = 'run_company' and subject_id = any(${tracker.runCompanyIds})`;
		await sql`delete from person where company_id = any(${tracker.companyIds})`;
		await sql`delete from run_company where run_id = any(${tracker.runIds})`;
		await sql`delete from company where id = any(${tracker.companyIds})`;
		await sql`delete from run where id = any(${tracker.runIds})`;
		if (tracker.organizationIds.length > 0) {
			await sql`delete from organization where id = any(${tracker.organizationIds})`;
		}
	} finally {
		await sql.end();
	}
}

describe("tracePeopleRun", () => {
	const tracker: PeopleFixtureTracker = {
		organizationIds: [],
		runIds: [],
		companyIds: [],
		runCompanyIds: [],
	};

	afterAll(() => cleanUpPeopleFixture(tracker));

	it("reads a verified pick's verdict and quote check off the person and run_company evidence", async () => {
		const url = testEnv.HYPERDRIVE_DIRECT.connectionString;
		const { runId } = await seedPeopleRunFixture(fakeEnv(url), tracker);
		const spec = await readPeopleTraceSpec(url, runId);
		expect(spec.name).toBe("people-run");
		const companySpan = spec.children.find(
			(child) => child.name === "company-good.com",
		);
		expect(companySpan?.output).toMatchObject({ rosterSize: 8 });
		expect(companySpan?.children).toHaveLength(1);
		const pick = companySpan?.children[0];
		expect(pick?.output).toMatchObject({
			verified: true,
			verdict: "CONFIRMED",
			quoteCheck: { found: true, reason: "found" },
		});
	});
});
