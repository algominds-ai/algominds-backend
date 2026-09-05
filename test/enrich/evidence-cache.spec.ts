import { describe, expect, it } from "vitest";
import type {
	EnrichDeps,
	EnrichSubject,
	LinkedinInput,
	LinkedinResult,
} from "@/core/enrich";
import { enrich } from "@/core/enrich";
import type { Provider } from "@/core/providers/types";
import { fakeReadEvidence, fakeWriteEvidence } from "../support/db";
import { fakeSecretEnv } from "../support/env";
import { fakeFindymail } from "../support/fetch";
import { evidenceRow } from "../support/rows";

function baseDeps(overrides: Partial<EnrichDeps> = {}): EnrichDeps {
	return {
		env: fakeSecretEnv({ FINDYMAIL_API_KEY: "test-key" }),
		readEvidence: fakeReadEvidence(undefined),
		writeEvidence: fakeWriteEvidence([]),
		...overrides,
	};
}

function daysAgo(now: Date, days: number): Date {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("the email evidence cache", () => {
	const now = new Date("2026-08-27T00:00:00.000Z");
	const subjects: EnrichSubject[] = [{ id: "subject-1" }];

	it("reuses evidence inside the ninety-day window", async () => {
		const fresh = evidenceRow({
			kind: "email",
			value: "max@tryramp.com",
			source: "linkedin",
			status: "verified",
			seenAt: daysAgo(now, 89),
		});

		const { outcomes } = await enrich(
			subjects,
			["email"],
			baseDeps({ readEvidence: fakeReadEvidence(fresh), now: () => now }),
		);

		expect(outcomes[0]?.email).toEqual({
			status: "verified",
			value: "max@tryramp.com",
			source: "linkedin",
		});
	});

	it("re-runs the waterfall once evidence ages past the ninety-day window", async () => {
		const stale = evidenceRow({
			kind: "email",
			value: "stale@tryramp.com",
			source: "linkedin",
			status: "verified",
			seenAt: daysAgo(now, 91),
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fakeFindymail({});

		const { outcomes } = await enrich(
			subjects,
			["email"],
			baseDeps({ readEvidence: fakeReadEvidence(stale), now: () => now }),
		);
		globalThis.fetch = originalFetch;

		expect(outcomes[0]?.email?.value).not.toBe("stale@tryramp.com");
	});
});

describe("the linkedin evidence cache", () => {
	const now = new Date("2026-08-27T00:00:00.000Z");
	const subjects: EnrichSubject[] = [{ id: "subject-1" }];

	function linkedinProvider(
		run: (input: LinkedinInput) => Promise<LinkedinResult | null>,
	): Provider<LinkedinInput, LinkedinResult> {
		return { id: "linkedin-search", run };
	}

	it("reuses evidence inside the thirty-day window", async () => {
		const fresh = evidenceRow({
			kind: "linkedin",
			value: "https://linkedin.com/in/cached",
			source: "subject",
			status: "found",
			seenAt: daysAgo(now, 29),
		});
		const untouched = linkedinProvider(async () => {
			throw new Error("must not be called within the TTL");
		});

		const { outcomes } = await enrich(
			subjects,
			["linkedin"],
			baseDeps({
				readEvidence: fakeReadEvidence(fresh),
				now: () => now,
				linkedinProviders: [untouched],
			}),
		);

		expect(outcomes[0]?.linkedin).toEqual({
			status: "found",
			value: "https://linkedin.com/in/cached",
			source: "subject",
		});
	});

	it("re-runs the waterfall once evidence ages past the thirty-day window", async () => {
		const stale = evidenceRow({
			kind: "linkedin",
			value: "https://linkedin.com/in/stale",
			source: "subject",
			status: "found",
			seenAt: daysAgo(now, 31),
		});
		let called = false;
		const refreshing = linkedinProvider(async () => {
			called = true;
			return { url: "https://linkedin.com/in/fresh" };
		});

		const { outcomes } = await enrich(
			subjects,
			["linkedin"],
			baseDeps({
				readEvidence: fakeReadEvidence(stale),
				now: () => now,
				linkedinProviders: [refreshing],
			}),
		);

		expect(called).toBe(true);
		expect(outcomes[0]?.linkedin?.value).toBe("https://linkedin.com/in/fresh");
	});
});
