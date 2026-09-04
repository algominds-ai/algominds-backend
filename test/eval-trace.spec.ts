import { env as testEnv } from "cloudflare:workers";
import type { RunReport } from "@eval/headline";
import type { KeyFile } from "@eval/label-core";
import { emptyKeyFile } from "@eval/label-core";
import type { CompanyTraceRecord, RoundTraceRecord } from "@eval/read";
import { buildCompanyRunTrace, traceCompaniesRun } from "@eval/trace";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { DbEnv } from "../src/core/db/client";
import { createIcp } from "../src/core/db/icp";
import { organizationForSlug } from "../src/core/db/organizations";
import {
	appendEvidence,
	saveCompanies,
	saveRound,
} from "../src/core/db/queries";
import { closeRun, openRun } from "../src/core/db/runs";

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
		secondsByDep: {},
		...overrides,
	};
}

function company(
	overrides: Partial<CompanyTraceRecord> = {},
): CompanyTraceRecord {
	return {
		domain: "americanitsolutions.com",
		name: "American IT Solutions, Inc",
		industry: null,
		description: "provides World Class Technology Services to Small Businesses",
		workforceTotal: 42,
		country: "United States",
		citedPage: null,
		quote: null,
		evidenceCheck: null,
		fitReason: "MSP with 42 employees serving external clients across US",
		...overrides,
	};
}

function keyFile(label: string | null): KeyFile {
	const base = emptyKeyFile("mstone", "icp-1");
	if (label === null) return base;
	return {
		...base,
		companies: {
			"americanitsolutions.com": {
				label,
				name: "American IT Solutions, Inc",
				firstSeenRunId: "run-0",
				lastSeenAt: "2026-01-01T00:00:00.000Z",
			},
		},
	};
}

const REFUSED_MAP = new Map([
	[
		1,
		[
			{
				domain: "valiify.com",
				reason:
					"Vendor selling account-opening software to banks, not itself onboarding end customers",
				statuses: [{ id: "r1", status: "contradicted" }],
			},
		],
	],
]);

type CompanyRunTraceOverrides = Partial<
	Parameters<typeof buildCompanyRunTrace>[0]
>;

function companyRunTraceInput(overrides: CompanyRunTraceOverrides = {}) {
	return {
		run: run(),
		meta: { profile: "mstone", arm: "baseline", trial: 0, commit: "abc123" },
		rounds: [round()],
		refusalsByRound: REFUSED_MAP,
		companies: [company()],
		key: keyFile("accept"),
		requiresProvingPass: true,
		hardRecordRequirementTexts: ["provides IT services to external clients"],
		...overrides,
	};
}

describe("buildCompanyRunTrace", () => {
	it("names the root span and carries the run's own metadata", () => {
		const trace = buildCompanyRunTrace(companyRunTraceInput());
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
		const trace = buildCompanyRunTrace(
			companyRunTraceInput({ companies: [], key: keyFile(null) }),
		);
		const roundSpan = trace.children.find((child) => child.name === "round-1");
		expect(roundSpan?.scores).toEqual({ route_matches_shape: 0 });
		const refused = roundSpan?.children.find(
			(child) => child.name === "refused",
		);
		const refusedRow = refused?.children.find(
			(child) => child.name === "refused-valiify.com",
		);
		expect(refusedRow?.metadata).toMatchObject({
			domain: "valiify.com",
			headcountTotal: null,
			country: null,
			fitReason: null,
			judgeReason: REFUSED_MAP.get(1)?.[0]?.reason,
		});
	});

	it("gives every stored company its own span carrying the record, fit reason and scores", () => {
		const trace = buildCompanyRunTrace(
			companyRunTraceInput({ rounds: [], refusalsByRound: new Map() }),
		);
		const companySpan = trace.children.find(
			(child) => child.name === "company-americanitsolutions.com",
		);
		expect(companySpan?.output).toMatchObject({
			fitReason: "MSP with 42 employees serving external clients across US",
		});
		expect(companySpan?.expected).toBe("accept");
		expect(companySpan?.scores).toEqual({ key_accepted: 1, gate_proven: 0 });
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
				query: "IT service providers with an external client base",
				angle: "managed-it",
				source: "exa-search",
				countries: ["US"],
				minWorkforce: 20,
				maxWorkforce: 200,
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
					domain: "valiify.com",
					reason: "sells to banks, does not onboard its own customers",
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
		domain: "americanitsolutions.com",
		name: "American IT Solutions, Inc",
		runId,
		data: {
			provider: "exa-search",
			entity: {
				description: "provides World Class Technology Services",
				workforceTotal: 42,
				country: "United States",
			},
			result: { fitReason: "MSP with 42 employees serving external clients" },
		},
	};
}

async function seedCompanyRunFixture(
	env: DbEnv,
	tracker: FixtureTracker,
): Promise<{ runId: string; icpId: string }> {
	const org = await organizationForSlug(
		env,
		`eval-trace-test-org-${crypto.randomUUID()}`,
		"Eval Trace Test",
	);
	tracker.organizationIds.push(org.id);
	const icpRow = await createIcp(env, {
		organizationId: org.id,
		domain: "seller.example",
		description: "sells managed IT services",
		requirements: [
			{
				id: "r1",
				text: "provides IT services directly to external client businesses",
				kind: "hard",
				proof: "record",
				windowDays: null,
			},
		],
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
	return { runId, icpId: icpRow.id };
}

async function readCompaniesTraceSpec(
	url: string,
	runId: string,
	icpId: string,
): Promise<Awaited<ReturnType<typeof traceCompaniesRun>>> {
	const sql = postgres(url, { max: 1 });
	try {
		return await traceCompaniesRun(
			sql,
			runId,
			{ icpId, key: keyFile("accept") },
			{ profile: "mstone", arm: "baseline", trial: 0, commit: "abc123" },
		);
	} finally {
		await sql.end();
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

describe("traceCompaniesRun", () => {
	const tracker: FixtureTracker = {
		organizationIds: [],
		icpIds: [],
		runIds: [],
	};

	afterAll(() => cleanUpCompanyFixture(tracker));

	it("rebuilds a span tree from a fixture run stored through the real save path", async () => {
		const url = testEnv.HYPERDRIVE_DIRECT.connectionString;
		const { runId, icpId } = await seedCompanyRunFixture(fakeEnv(url), tracker);
		const spec = await readCompaniesTraceSpec(url, runId, icpId);
		expect(spec.name).toBe("companies-run");
		expect(spec.children.map((child) => child.name)).toEqual(
			expect.arrayContaining(["round-1", "company-americanitsolutions.com"]),
		);
		const companySpan = spec.children.find(
			(child) => child.name === "company-americanitsolutions.com",
		);
		expect(companySpan?.scores).toEqual({ key_accepted: 1, gate_proven: null });
	});
});
