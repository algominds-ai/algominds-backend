import { afterEach, describe, expect, it } from "vitest";
import type {
	EnrichDeps,
	EnrichSubject,
	LinkedinInput,
	LinkedinResult,
} from "@/core/enrich";
import { enrich, isSendable } from "@/core/enrich";
import type { Provider } from "@/core/providers/types";
import {
	fakeReadEvidence,
	fakeReadEvidenceSequence,
	fakeWriteEvidence,
} from "../support/db";
import { fakeSecretEnv } from "../support/env";
import {
	fakeFindymail,
	jsonResponse as json,
	requestedEmail,
} from "../support/fetch";
import { evidenceRow } from "../support/rows";

function findymailEnv(): Env {
	return fakeSecretEnv({
		FINDYMAIL_API_KEY: "test-key",
		EXA_API_KEY: "test-exa-key",
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

	it("runs only the requested channel's waterfall, and skips it entirely once the subject already carries a value", async () => {
		let emailCalls = 0;
		globalThis.fetch = async (input, init) => {
			emailCalls += 1;
			return fakeFindymail({})(input, init);
		};
		const linkedinCalls: string[] = [];
		const hits = linkedinProvider("linkedin-search", async () => {
			linkedinCalls.push("called");
			return { url: "https://linkedin.com/in/found" };
		});
		const known: EnrichSubject = {
			id: "subject-1",
			linkedinUrl: "https://linkedin.com/in/known",
		};

		const { outcomes: onlyLinkedin } = await enrich(
			[{ id: "subject-2", domain: "acme.com" }],
			["linkedin"],
			baseDeps({ linkedinProviders: [hits] }),
		);
		const { outcomes: alreadyKnown } = await enrich(
			[known],
			["linkedin"],
			baseDeps({ linkedinProviders: [hits] }),
		);

		expect(emailCalls).toBe(0);
		expect(onlyLinkedin[0]?.email).toBeUndefined();
		expect(linkedinCalls).toEqual(["called"]);
		expect(alreadyKnown[0]?.linkedin).toEqual({
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

	it("continues to the next finder when the verifier does not confirm, keeping the last value seen as unknown", async () => {
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

		const { outcomes } = await enrich(subjects, ["email"], baseDeps());

		expect(outcomes[0]?.email).toEqual({
			status: "unknown",
			value: "ghost@acme.com",
			source: "linkedin",
		});
		expect(isSendable(outcomes[0]?.email?.status ?? "unknown")).toBe(false);
	});

	it("yields unknown with no value when nothing is ever found", async () => {
		globalThis.fetch = fakeFindymail({});

		const { outcomes } = await enrich(
			[{ id: "subject-1" }],
			["email"],
			baseDeps(),
		);

		expect(outcomes[0]?.email).toEqual({
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

		const { outcomes } = await enrich(subjects, ["email"], baseDeps());

		expect(outcomes[0]?.email?.status).toBe("unknown");
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

		const { outcomes } = await enrich(
			[{ id: "subject-1", name: "Someone" }],
			["linkedin"],
			baseDeps({ linkedinProviders: [first, second] }),
		);

		expect(calls).toEqual(["first"]);
		expect(outcomes[0]?.linkedin?.value).toBe("https://linkedin.com/in/first");
	});
});

describe("isSendable", () => {
	it("is true only for a verified status, never for unknown", () => {
		expect(isSendable("unknown")).toBe(false);
		expect(isSendable("verified")).toBe(true);
	});
});

describe("enrich() result shape", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns both channel keys with per-channel statuses, not a throw, when one channel is found and the other missing", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "max@tryramp.com" } }),
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: true }),
		});
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", linkedinUrl: "https://linkedin.com/in/max" },
		];

		const { outcomes } = await enrich(
			subjects,
			["email", "linkedin"],
			baseDeps(),
		);

		expect(outcomes[0]?.email?.status).toBe("verified");
		expect(outcomes[0]?.linkedin).toEqual({
			status: "found",
			value: "https://linkedin.com/in/max",
			source: "subject",
		});
	});

	it("resolves a subject that never went through the people search, reading only evidence", async () => {
		const seenAt = new Date();
		const readEvidence = fakeReadEvidenceSequence([
			evidenceRow({
				kind: "email",
				value: "cached@acme.com",
				source: "name",
				status: "verified",
				seenAt,
			}),
			evidenceRow({
				kind: "linkedin",
				value: "https://linkedin.com/in/cached",
				source: "subject",
				status: "found",
				seenAt,
			}),
		]);

		const { outcomes } = await enrich(
			[{ id: "subject-1" }],
			["email", "linkedin"],
			baseDeps({ readEvidence }),
		);

		expect(outcomes[0]?.email?.value).toBe("cached@acme.com");
		expect(outcomes[0]?.linkedin?.value).toBe("https://linkedin.com/in/cached");
	});

	it("is called directly with plain arguments, needing no Hono context and no WorkflowStep", async () => {
		const subjects: EnrichSubject[] = [
			{ id: "subject-1", linkedinUrl: "https://linkedin.com/in/plain" },
		];

		const { outcomes } = await enrich(subjects, ["linkedin"], baseDeps());

		expect(outcomes).toEqual([
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
