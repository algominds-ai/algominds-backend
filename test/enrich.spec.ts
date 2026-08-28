import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { DbMode } from "../src/core/db/client";
import type {
	DbFactory,
	EvidenceAppendConnection,
	EvidenceReadConnection,
	RunLookupConnection,
} from "../src/core/db/queries";
import type {
	Company,
	Evidence,
	NewEvidence,
	Person,
	Run,
} from "../src/core/db/schema";
import { company } from "../src/core/db/schema";
import type {
	EnrichDeps,
	EnrichOutcome,
	EnrichSubject,
	LinkedinInput,
	LinkedinResult,
	RunCompanyExistsConnection,
	RunPeopleConnection,
	SubjectsDeps,
} from "../src/core/enrich";
import { enrich, isSendable, subjectsForRun } from "../src/core/enrich";
import { exaAgentEmailProvider } from "../src/core/providers/exa-agent-email";
import type { Provider } from "../src/core/providers/types";
import { RetryableProviderError } from "../src/core/providers/waterfall";
import { toBatches } from "../src/workflows/enrich";

type Handler = (init: RequestInit | undefined) => Response;

function findymailEnv(): Env {
	return {
		...testEnv,
		FINDYMAIL_API_KEY: { get: async () => "test-key" },
		EXA_API_KEY: { get: async () => "test-exa-key" },
	};
}

function fakeFindymail(handlers: Record<string, Handler>): typeof fetch {
	return async (input, init) => {
		const pathname = new URL(String(input)).pathname;
		const handler = handlers[pathname];
		if (!handler) return new Response(null, { status: 404 });
		return handler(init);
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestedEmail(init: RequestInit | undefined): string {
	const body: { email?: string } = JSON.parse(String(init?.body ?? "{}"));
	return body.email ?? "";
}

function evidenceRow(fields: {
	kind: string;
	value: string;
	source: string;
	status: string | null;
	seenAt: Date;
}): Evidence {
	return {
		id: "evidence-1",
		subjectType: "person",
		subjectId: "subject-1",
		confidence: null,
		...fields,
	};
}

function fakeReadEvidence(
	row: Evidence | undefined,
): DbFactory<EvidenceReadConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: () => Promise.resolve(row ? [row] : []),
					}),
				}),
			}),
		}),
	});
}

function fakeReadEvidenceSequence(
	rows: (Evidence | undefined)[],
): DbFactory<EvidenceReadConnection> {
	let call = 0;
	return () => {
		const row = rows[call];
		call += 1;
		return {
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => ({
							limit: () => Promise.resolve(row ? [row] : []),
						}),
					}),
				}),
			}),
		};
	};
}

function fakeWriteEvidence(
	sink: NewEvidence[],
): DbFactory<EvidenceAppendConnection> {
	return () => ({
		insert: () => ({
			values: (rows: NewEvidence | NewEvidence[]) => {
				sink.push(...(Array.isArray(rows) ? rows : [rows]));
				return { returning: () => Promise.resolve([]) };
			},
		}),
	});
}

function linkedinProvider(
	id: string,
	run: (input: LinkedinInput, env: Env) => Promise<LinkedinResult | null>,
): Provider<LinkedinInput, LinkedinResult> {
	return { id, channels: ["linkedin"], cost: 0, run };
}

function baseDeps(overrides: Partial<EnrichDeps> = {}): EnrichDeps {
	return {
		env: findymailEnv(),
		readEvidence: fakeReadEvidence(undefined),
		writeEvidence: fakeWriteEvidence([]),
		...overrides,
	};
}

describe("channel selection", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("runs only the linkedin waterfall when only linkedin is requested", async () => {
		let emailCalls = 0;
		globalThis.fetch = async (input, init) => {
			emailCalls += 1;
			return fakeFindymail({})(input, init);
		};
		const hits = linkedinProvider("linkedin-search", async () => ({
			url: "https://linkedin.com/in/found",
		}));
		const subjects: EnrichSubject[] = [{ id: "subject-1", domain: "acme.com" }];

		const results = await enrich(
			subjects,
			["linkedin"],
			baseDeps({ linkedinProviders: [hits] }),
		);

		expect(emailCalls).toBe(0);
		expect(results[0]?.email).toBeUndefined();
		expect(results[0]?.linkedin?.status).toBe("found");
	});

	it("makes no provider call when the subject already carries a linkedin URL", async () => {
		const calls: string[] = [];
		const provider = linkedinProvider("linkedin-search", async () => {
			calls.push("called");
			return { url: "https://linkedin.com/in/should-not-be-used" };
		});
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", linkedinUrl: "https://linkedin.com/in/known" },
		];

		const results = await enrich(
			subjects,
			["linkedin"],
			baseDeps({ linkedinProviders: [provider] }),
		);

		expect(calls).toEqual([]);
		expect(results[0]?.linkedin).toEqual({
			status: "found",
			value: "https://linkedin.com/in/known",
			source: "subject",
		});
	});
});

describe("the email waterfall", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("continues to the next finder when the verifier does not confirm, and returns unknown with the last value seen", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "ghost@acme.com" } }),
			"/api/search/name": () => new Response(null, { status: 404 }),
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: false }),
		});
		const subjects: EnrichSubject[] = [
			{
				id: "subject-1",
				name: "Ghost Person",
				domain: "acme.com",
				linkedinUrl: "https://linkedin.com/in/ghost",
			},
		];

		const results = await enrich(subjects, ["email"], baseDeps());

		expect(results[0]?.email?.status).toBe("unknown");
		expect(results[0]?.email?.value).toBe("ghost@acme.com");
		expect(isSendable(results[0]?.email?.status ?? "unknown")).toBe(false);
	});

	it("yields unknown with no value when nothing is ever found", async () => {
		globalThis.fetch = fakeFindymail({});
		const subjects: EnrichSubject[] = [{ id: "subject-1" }];

		const results = await enrich(subjects, ["email"], baseDeps());

		expect(results[0]?.email).toEqual({
			status: "unknown",
			value: null,
			source: null,
		});
	});

	it("rejects a role address even when the verifier confirms it", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "sales@acme.com" } }),
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: true }),
		});
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", linkedinUrl: "https://linkedin.com/in/sales-team" },
		];

		const results = await enrich(subjects, ["email"], baseDeps());

		expect(results[0]?.email?.status).toBe("unknown");
	});
});

function fakeVendors(
	findymail: Record<string, Handler>,
	exa: Record<string, Handler>,
): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		const table = url.hostname === "api.exa.ai" ? exa : findymail;
		const handler = table[url.pathname];
		return handler ? handler(init) : new Response(null, { status: 404 });
	};
}

function completedAgentRun(overrides: { output?: unknown } = {}) {
	return {
		id: "agent-run-1",
		status: "completed",
		output: {
			structured: {
				fullName: "Kirk Marple",
				title: "Founder and Chief Executive Officer",
				email: "kirk@graphlit.com",
				linkedinUrl: "https://www.linkedin.com/in/kirkmarple",
				source: "https://www.linkedin.com/posts/kirkmarple_hiring",
			},
		},
		costDollars: { total: 0.025, agentCompute: 0.02, search: 0.005 },
		...overrides,
	};
}

describe("the exa agent email provider in the waterfall", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("never reaches the agent once an earlier provider verifies an email", async () => {
		let agentStarted = false;
		globalThis.fetch = fakeVendors(
			{
				"/api/search/linkedin": () =>
					json({ contact: { email: "max@tryramp.com" } }),
				"/api/verify": (init) =>
					json({ email: requestedEmail(init), verified: true }),
			},
			{
				"/agent/runs": () => {
					agentStarted = true;
					return json({ id: "agent-run-1", status: "running" });
				},
			},
		);
		const subjects: EnrichSubject[] = [
			{
				id: "subject-1",
				name: "Max Freeman",
				domain: "tryramp.com",
				linkedinUrl: "https://linkedin.com/in/max",
			},
		];

		const results = await enrich(subjects, ["email"], baseDeps());

		expect(agentStarted).toBe(false);
		expect(results[0]?.email?.status).toBe("verified");
	});

	it("falls through to the agent when every findymail provider misses", async () => {
		globalThis.fetch = fakeVendors(
			{
				"/api/search/linkedin": () => new Response(null, { status: 404 }),
				"/api/search/name": () => new Response(null, { status: 404 }),
			},
			{
				"/agent/runs": () => json({ id: "agent-run-1", status: "running" }),
				"/agent/runs/agent-run-1": () => json(completedAgentRun()),
			},
		);
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", name: "Kirk Marple", domain: "graphlit.com" },
		];

		const results = await enrich(subjects, ["email"], baseDeps());

		expect(results[0]?.email?.value).toBe("kirk@graphlit.com");
	});

	it("records the agent's cited source url as evidence, not just a finder label", async () => {
		globalThis.fetch = fakeVendors(
			{
				"/api/search/linkedin": () => new Response(null, { status: 404 }),
				"/api/search/name": () => new Response(null, { status: 404 }),
			},
			{
				"/agent/runs": () => json({ id: "agent-run-1", status: "running" }),
				"/agent/runs/agent-run-1": () => json(completedAgentRun()),
			},
		);
		const evidenceSink: NewEvidence[] = [];
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", name: "Kirk Marple", domain: "graphlit.com" },
		];

		await enrich(
			subjects,
			["email"],
			baseDeps({ writeEvidence: fakeWriteEvidence(evidenceSink) }),
		);

		const emailRow = evidenceSink.find((row) => row.kind === "email");
		expect(emailRow?.value).toBe("kirk@graphlit.com");
		expect(emailRow?.source).toBe(
			"https://www.linkedin.com/posts/kirkmarple_hiring",
		);
	});
});

describe("the exa agent email provider's own error contract", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null without throwing when the agent completes with no email", async () => {
		globalThis.fetch = fakeVendors(
			{},
			{
				"/agent/runs": () => json({ id: "agent-run-1", status: "running" }),
				"/agent/runs/agent-run-1": () =>
					json(completedAgentRun({ output: { structured: { email: null } } })),
			},
		);

		const result = await exaAgentEmailProvider.run(
			{ name: "Nobody Found", domain: "acme.com" },
			findymailEnv(),
		);

		expect(result).toBeNull();
	});

	it("raises a retryable error on a 429 from the agent", async () => {
		globalThis.fetch = fakeVendors(
			{},
			{ "/agent/runs": () => new Response(null, { status: 429 }) },
		);

		await expect(
			exaAgentEmailProvider.run(
				{ name: "Someone", domain: "acme.com" },
				findymailEnv(),
			),
		).rejects.toThrow(RetryableProviderError);
	});

	it("raises a non-retryable error, not a retryable one, when the run terminates as failed", async () => {
		globalThis.fetch = fakeVendors(
			{},
			{
				"/agent/runs": () => json({ id: "agent-run-1", status: "running" }),
				"/agent/runs/agent-run-1": () =>
					json({ id: "agent-run-1", status: "failed" }),
			},
		);

		let caught: unknown;
		try {
			await exaAgentEmailProvider.run(
				{ name: "Someone", domain: "acme.com" },
				findymailEnv(),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NonRetryableError);
		expect(caught).not.toBeInstanceOf(RetryableProviderError);
	});
});

describe("isSendable", () => {
	it("is never true for unknown", () => {
		expect(isSendable("unknown")).toBe(false);
	});

	it("is true for verified", () => {
		expect(isSendable("verified")).toBe(true);
	});
});

type Recorded = { condition?: unknown; mode?: DbMode };

function fakeFindRun(row: Run | undefined): DbFactory<RunLookupConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(row ? [row] : []),
				}),
			}),
		}),
	});
}

function fakeCompanyExists(
	rows: { id: string }[],
	recorded: Recorded = {},
): DbFactory<RunCompanyExistsConnection> {
	return (_env, mode) => {
		recorded.mode = mode;
		return {
			select: () => ({
				from: () => ({
					where: (condition) => {
						recorded.condition = condition;
						return Promise.resolve(rows);
					},
				}),
			}),
		};
	};
}

function fakeRunPeople(
	rows: { person: Person; company: Company }[],
	recorded: Recorded = {},
): DbFactory<RunPeopleConnection> {
	return (_env, mode) => {
		recorded.mode = mode;
		return {
			select: () => ({
				from: () => ({
					innerJoin: () => ({
						where: (condition) => {
							recorded.condition = condition;
							return Promise.resolve(rows);
						},
					}),
				}),
			}),
		};
	};
}

function runRow(overrides: Partial<Run> = {}): Run {
	return {
		id: "companies_icp-1_2026-08-27",
		accountId: "account-1",
		icpId: "icp-1",
		capability: "companies",
		status: "running",
		costDollars: 0,
		startedAt: new Date("2026-08-27T00:00:00.000Z"),
		finishedAt: null,
		...overrides,
	};
}

function personCompanyRows(
	companyRow: Company,
): { person: Person; company: Company }[] {
	return [
		{
			person: {
				id: "person-1",
				companyId: companyRow.id,
				linkedinUrl: "https://linkedin.com/in/a",
				name: "Ada",
				title: "VP",
				data: null,
			},
			company: companyRow,
		},
		{
			person: {
				id: "person-2",
				companyId: companyRow.id,
				linkedinUrl: null,
				name: null,
				title: null,
				data: null,
			},
			company: companyRow,
		},
	];
}

const EXPECTED_SUBJECTS = [
	{
		id: "person-1",
		domain: "acme.com",
		name: "Ada",
		linkedinUrl: "https://linkedin.com/in/a",
	},
	{ id: "person-2", domain: "acme.com" },
];

describe("subjectsForRun", () => {
	it("resolves the people of a companies run's companies, reading through the direct binding", async () => {
		const run = runRow({
			id: "companies_icp-1_2026-08-27",
			capability: "companies",
		});
		const companyRow: Company = {
			id: "company-1",
			icpId: "icp-1",
			domain: "acme.com",
			name: "Acme",
			data: null,
			runId: run.id,
			foundAt: new Date(),
		};
		const existsRecorded: Recorded = {};
		const peopleRecorded: Recorded = {};
		const deps: SubjectsDeps = {
			findRun: fakeFindRun(run),
			companyExists: fakeCompanyExists([{ id: companyRow.id }], existsRecorded),
			runPeople: fakeRunPeople(personCompanyRows(companyRow), peopleRecorded),
		};

		const subjects = await subjectsForRun(testEnv, run.id, deps);

		expect(subjects).toEqual(EXPECTED_SUBJECTS);
		expect(existsRecorded.condition).toEqual(eq(company.runId, run.id));
		expect(peopleRecorded.condition).toEqual(eq(company.runId, run.id));
		expect(existsRecorded.mode).toBe("direct");
		expect(peopleRecorded.mode).toBe("direct");
	});

	it("resolves the same people for a people run id, rather than an empty set", async () => {
		const run = runRow({ id: "people_icp-1_2026-08-27", capability: "people" });
		const companyRow: Company = {
			id: "company-1",
			icpId: run.icpId,
			domain: "acme.com",
			name: "Acme",
			data: null,
			runId: "companies_icp-1_2026-08-26",
			foundAt: new Date(),
		};
		const existsRecorded: Recorded = {};
		const peopleRecorded: Recorded = {};
		const deps: SubjectsDeps = {
			findRun: fakeFindRun(run),
			companyExists: fakeCompanyExists([{ id: companyRow.id }], existsRecorded),
			runPeople: fakeRunPeople(personCompanyRows(companyRow), peopleRecorded),
		};

		const subjects = await subjectsForRun(testEnv, run.id, deps);

		expect(subjects).toEqual(EXPECTED_SUBJECTS);
		expect(existsRecorded.condition).toEqual(eq(company.icpId, run.icpId));
		expect(peopleRecorded.condition).toEqual(eq(company.icpId, run.icpId));
	});

	it("throws rather than returning an empty list when the run matches no company", async () => {
		const run = runRow({
			id: "companies_icp-2_2026-08-27",
			capability: "companies",
		});
		const deps: SubjectsDeps = {
			findRun: fakeFindRun(run),
			companyExists: fakeCompanyExists([]),
			runPeople: fakeRunPeople([]),
		};

		await expect(subjectsForRun(testEnv, run.id, deps)).rejects.toThrow(
			NonRetryableError,
		);
	});

	it("throws when the run id matches no run at all", async () => {
		const deps: SubjectsDeps = { findRun: fakeFindRun(undefined) };

		await expect(subjectsForRun(testEnv, "unknown_run", deps)).rejects.toThrow(
			NonRetryableError,
		);
	});

	it("throws for a capability that carries no company scope", async () => {
		const run = runRow({ id: "enrich_icp-1_2026-08-27", capability: "enrich" });
		const deps: SubjectsDeps = { findRun: fakeFindRun(run) };

		await expect(subjectsForRun(testEnv, run.id, deps)).rejects.toThrow(
			NonRetryableError,
		);
	});
});

describe("the email evidence cache", () => {
	it("reuses email evidence 89 days old", async () => {
		const now = new Date("2026-08-27T00:00:00.000Z");
		const seenAt = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);
		const cached = evidenceRow({
			kind: "email",
			value: "max@tryramp.com",
			source: "linkedin",
			status: "verified",
			seenAt,
		});
		const subjects: EnrichSubject[] = [{ id: "subject-1" }];

		const results = await enrich(
			subjects,
			["email"],
			baseDeps({ readEvidence: fakeReadEvidence(cached), now: () => now }),
		);

		expect(results[0]?.email).toEqual({
			status: "verified",
			value: "max@tryramp.com",
			source: "linkedin",
		});
	});

	it("re-runs the waterfall for email evidence 91 days old", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fakeFindymail({});
		const now = new Date("2026-08-27T00:00:00.000Z");
		const seenAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
		const cached = evidenceRow({
			kind: "email",
			value: "stale@tryramp.com",
			source: "linkedin",
			status: "verified",
			seenAt,
		});
		const subjects: EnrichSubject[] = [{ id: "subject-1" }];

		const results = await enrich(
			subjects,
			["email"],
			baseDeps({ readEvidence: fakeReadEvidence(cached), now: () => now }),
		);

		globalThis.fetch = originalFetch;
		expect(results[0]?.email?.value).not.toBe("stale@tryramp.com");
	});
});

describe("the linkedin evidence cache", () => {
	it("reuses linkedin evidence 29 days old", async () => {
		const now = new Date("2026-08-27T00:00:00.000Z");
		const seenAt = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
		const cached = evidenceRow({
			kind: "linkedin",
			value: "https://linkedin.com/in/cached",
			source: "subject",
			status: "found",
			seenAt,
		});
		const provider = linkedinProvider("linkedin-search", async () => {
			throw new Error("must not be called within the TTL");
		});
		const subjects: EnrichSubject[] = [{ id: "subject-1" }];

		const results = await enrich(
			subjects,
			["linkedin"],
			baseDeps({
				readEvidence: fakeReadEvidence(cached),
				now: () => now,
				linkedinProviders: [provider],
			}),
		);

		expect(results[0]?.linkedin).toEqual({
			status: "found",
			value: "https://linkedin.com/in/cached",
			source: "subject",
		});
	});

	it("re-runs the waterfall for linkedin evidence 31 days old", async () => {
		const now = new Date("2026-08-27T00:00:00.000Z");
		const seenAt = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
		const cached = evidenceRow({
			kind: "linkedin",
			value: "https://linkedin.com/in/stale",
			source: "subject",
			status: "found",
			seenAt,
		});
		let called = false;
		const provider = linkedinProvider("linkedin-search", async () => {
			called = true;
			return { url: "https://linkedin.com/in/fresh" };
		});
		const subjects: EnrichSubject[] = [{ id: "subject-1" }];

		const results = await enrich(
			subjects,
			["linkedin"],
			baseDeps({
				readEvidence: fakeReadEvidence(cached),
				now: () => now,
				linkedinProviders: [provider],
			}),
		);

		expect(called).toBe(true);
		expect(results[0]?.linkedin?.value).toBe("https://linkedin.com/in/fresh");
	});
});

describe("the linkedin waterfall", () => {
	it("stops on the first hit even without a verified status", async () => {
		const calls: string[] = [];
		const first = linkedinProvider("first", async () => {
			calls.push("first");
			return { url: "https://linkedin.com/in/first" };
		});
		const second = linkedinProvider("second", async () => {
			calls.push("second");
			return { url: "https://linkedin.com/in/second" };
		});
		const subjects: EnrichSubject[] = [{ id: "subject-1", name: "Someone" }];

		const results = await enrich(
			subjects,
			["linkedin"],
			baseDeps({ linkedinProviders: [first, second] }),
		);

		expect(calls).toEqual(["first"]);
		expect(results[0]?.linkedin?.value).toBe("https://linkedin.com/in/first");
	});
});

describe("enrich() result shape", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns both channel keys with per-channel statuses, not a throw, when email is found and linkedin is missing", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "max@tryramp.com" } }),
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: true }),
		});
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", linkedinUrl: "https://linkedin.com/in/max" },
		];

		const results = await enrich(subjects, ["email", "linkedin"], baseDeps());

		expect(results[0]?.email?.status).toBe("verified");
		expect(results[0]?.linkedin).toEqual({
			status: "found",
			value: "https://linkedin.com/in/max",
			source: "subject",
		});
	});

	it("works on a subject that never went through the people search, reading only evidence", async () => {
		const seenAt = new Date();
		const emailRow = evidenceRow({
			kind: "email",
			value: "cached@acme.com",
			source: "name",
			status: "verified",
			seenAt,
		});
		const linkedinRow = evidenceRow({
			kind: "linkedin",
			value: "https://linkedin.com/in/cached",
			source: "subject",
			status: "found",
			seenAt,
		});
		const subjects: EnrichSubject[] = [{ id: "subject-1" }];

		const results = await enrich(
			subjects,
			["email", "linkedin"],
			baseDeps({
				readEvidence: fakeReadEvidenceSequence([emailRow, linkedinRow]),
			}),
		);

		expect(results[0]?.email?.value).toBe("cached@acme.com");
		expect(results[0]?.linkedin?.value).toBe("https://linkedin.com/in/cached");
	});

	it("is called directly with plain arguments, with no Hono context and no WorkflowStep", async () => {
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", linkedinUrl: "https://linkedin.com/in/plain" },
		];

		const results = await enrich(subjects, ["linkedin"], baseDeps());

		expect(results).toEqual([
			{
				subjectId: "subject-1",
				linkedin: {
					status: "found",
					value: "https://linkedin.com/in/plain",
					source: "subject",
				},
			},
		]);
	});
});

type StepMocker = {
	mockStepResult: (s: { name: string }, v: unknown) => Promise<void>;
};

async function mockRunBookkeeping(m: StepMocker): Promise<void> {
	await m.mockStepResult(
		{ name: "load-source-run" },
		{ accountId: "account-1", icpId: "icp-1" },
	);
	await m.mockStepResult({ name: "open-run" }, { id: "x" });
	await m.mockStepResult({ name: "close-run" }, { id: "x" });
}

describe("EnrichWorkflow", () => {
	it("splits subjects into ordered groups of five", () => {
		const subjects: EnrichSubject[] = Array.from({ length: 12 }, (_, i) => ({
			id: `subject-${i}`,
		}));

		const batches = toBatches(subjects);

		expect(batches.map((batch) => batch.length)).toEqual([5, 5, 2]);
		expect(batches[0]?.[0]?.id).toBe("subject-0");
		expect(batches[2]?.[1]?.id).toBe("subject-11");
	});
});

describe("EnrichWorkflow: resolving a run", () => {
	it("resolves a run into subjects and runs one step per batch", async () => {
		const instanceId = "enrich_workflow_batches_test";
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			const subjects: EnrichSubject[] = Array.from({ length: 6 }, (_, i) => ({
				id: `subject-${i}`,
			}));
			const batchZero: EnrichOutcome[] = Array.from({ length: 5 }, (_, i) => ({
				subjectId: `subject-${i}`,
				linkedin: {
					status: "found",
					value: `https://linkedin.com/in/${i}`,
					source: "subject",
				},
			}));
			const batchOne: EnrichOutcome[] = [
				{
					subjectId: "subject-5",
					linkedin: {
						status: "found",
						value: "https://linkedin.com/in/5",
						source: "subject",
					},
				},
			];
			await instance.modify(async (m) => {
				await mockRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult({ name: "enrich-batch-0" }, batchZero);
				await m.mockStepResult({ name: "enrich-batch-1" }, batchOne);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_batches", channels: ["linkedin"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual([...batchZero, ...batchOne]);
		} finally {
			await instance.dispose();
		}
	});

	it("a run resolving to three people enriches three", async () => {
		const instanceId = "enrich_workflow_three_people_test";
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			const subjects: EnrichSubject[] = [
				{ id: "person-a" },
				{ id: "person-b" },
				{ id: "person-c" },
			];
			const outcomes: EnrichOutcome[] = subjects.map((subject) => ({
				subjectId: subject.id,
				linkedin: { status: "unknown", value: null, source: null },
			}));
			await instance.modify(async (m) => {
				await mockRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult({ name: "enrich-batch-0" }, outcomes);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_three", channels: ["linkedin"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual(outcomes);
		} finally {
			await instance.dispose();
		}
	});

	it("a run resolving to no people returns an empty list without throwing", async () => {
		const instanceId = "enrich_workflow_no_people_test";
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await mockRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, []);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_empty", channels: ["email"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual([]);
		} finally {
			await instance.dispose();
		}
	});
});
