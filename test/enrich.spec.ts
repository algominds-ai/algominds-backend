import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type {
	DbFactory,
	EvidenceAppendConnection,
	EvidenceReadConnection,
} from "../src/core/db/queries";
import type {
	Company,
	Evidence,
	NewEvidence,
	Person,
} from "../src/core/db/schema";
import type {
	EnrichDeps,
	EnrichOutcome,
	EnrichSubject,
	LinkedinInput,
	LinkedinResult,
	RunPeopleConnection,
} from "../src/core/enrich";
import { enrich, isSendable, subjectsForRun } from "../src/core/enrich";
import type { Provider } from "../src/core/providers/types";
import { toBatches } from "../src/workflows/enrich";

type Handler = (init: RequestInit | undefined) => Response;

function findymailEnv(): Env {
	return { ...testEnv, FINDYMAIL_API_KEY: { get: async () => "test-key" } };
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

describe("isSendable", () => {
	it("is never true for unknown", () => {
		expect(isSendable("unknown")).toBe(false);
	});

	it("is true for verified", () => {
		expect(isSendable("verified")).toBe(true);
	});
});

function fakeRunPeople(
	rows: { person: Person; company: Company }[],
): DbFactory<RunPeopleConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: () => Promise.resolve(rows),
				}),
			}),
		}),
	});
}

describe("subjectsForRun", () => {
	it("maps every person joined to their company's domain, for one run", async () => {
		const companyRow: Company = {
			id: "company-1",
			icpId: "icp-1",
			domain: "acme.com",
			name: "Acme",
			data: null,
			runId: "people_run_1",
			foundAt: new Date(),
		};
		const rows = [
			{
				person: {
					id: "person-1",
					companyId: "company-1",
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
					companyId: "company-1",
					linkedinUrl: null,
					name: null,
					title: null,
					data: null,
				},
				company: companyRow,
			},
		];

		const subjects = await subjectsForRun(
			testEnv,
			"people_run_1",
			fakeRunPeople(rows),
		);

		expect(subjects).toEqual([
			{
				id: "person-1",
				domain: "acme.com",
				name: "Ada",
				linkedinUrl: "https://linkedin.com/in/a",
			},
			{ id: "person-2", domain: "acme.com" },
		]);
	});

	it("returns an empty list when a run has no people", async () => {
		const subjects = await subjectsForRun(
			testEnv,
			"people_run_empty",
			fakeRunPeople([]),
		);

		expect(subjects).toEqual([]);
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
