import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import type { NewEvidence } from "@/core/db/schema";
import type { EnrichDeps, EnrichSubject } from "@/core/enrich";
import { enrich } from "@/core/enrich";
import { exaAgentEmailProvider } from "@/core/providers/exa/agent-email";
import { RetryableProviderError } from "@/core/providers/waterfall";
import { fakeReadEvidence, fakeWriteEvidence } from "../support/db";
import { fakeSecretEnv } from "../support/env";
import {
	completedAgentRun,
	fakeVendors,
	jsonResponse as json,
} from "../support/fetch";

function findymailEnv(): Env {
	return fakeSecretEnv({
		FINDYMAIL_API_KEY: "test-key",
		EXA_API_KEY: "test-exa-key",
	});
}

function baseDeps(overrides: Partial<EnrichDeps> = {}): EnrichDeps {
	return {
		env: findymailEnv(),
		readEvidence: fakeReadEvidence(undefined),
		writeEvidence: fakeWriteEvidence([]),
		...overrides,
	};
}

describe("the exa agent provider in the enrich waterfall", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("never starts once an earlier provider verifies an email", async () => {
		let agentStarted = false;
		globalThis.fetch = fakeVendors(
			{
				"/api/search/linkedin": () =>
					json({ contact: { email: "max@tryramp.com" } }),
				"/api/verify": () => json({ email: "max@tryramp.com", verified: true }),
			},
			{
				"/agent/runs": () => {
					agentStarted = true;
					return json({ id: "agent-run-1", status: "running" });
				},
			},
		);

		const { outcomes } = await enrich(
			[
				{
					id: "subject-1",
					name: "Max Freeman",
					domain: "tryramp.com",
					linkedinUrl: "https://linkedin.com/in/max",
				},
			],
			["email"],
			baseDeps(),
		);

		expect(agentStarted).toBe(false);
		expect(outcomes[0]?.email?.status).toBe("verified");
	});

	it("falls through to the agent once every findymail provider misses", async () => {
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

		const { outcomes } = await enrich(subjects, ["email"], baseDeps());

		expect(outcomes[0]?.email?.value).toBe("kirk@graphlit.com");
	});

	it("records the agent's cited source url as evidence, and its cost into the ledger", async () => {
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

		const { costDollars } = await enrich(
			subjects,
			["email"],
			baseDeps({ writeEvidence: fakeWriteEvidence(evidenceSink) }),
		);

		const emailRow = evidenceSink.find((row) => row.kind === "email");
		expect(emailRow?.value).toBe("kirk@graphlit.com");
		expect(emailRow?.source).toBe(
			"https://www.linkedin.com/posts/kirkmarple_hiring",
		);
		expect(costDollars).toBeGreaterThan(0);
	});

	it("still reports what every provider spent trying, when every one misses", async () => {
		globalThis.fetch = fakeVendors(
			{
				"/api/search/linkedin": () =>
					json({ contact: { email: "ghost@acme.com" } }),
				"/api/verify": () => json({ email: "ghost@acme.com", verified: false }),
				"/api/search/name": () => new Response(null, { status: 404 }),
			},
			{ "/agent/runs": () => new Response(null, { status: 404 }) },
		);
		const subjects: EnrichSubject[] = [
			{
				id: "subject-1",
				name: "Ghost Person",
				domain: "acme.com",
				linkedinUrl: "https://linkedin.com/in/ghost",
			},
		];

		const { outcomes, costDollars } = await enrich(
			subjects,
			["email"],
			baseDeps(),
		);

		expect(outcomes[0]?.email?.status).toBe("unknown");
		expect(costDollars).toBeGreaterThan(0);
	});
});

describe("exaAgentEmailProvider: its own failure contract", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null without throwing on no email found, or a rate-limited start", async () => {
		globalThis.fetch = fakeVendors(
			{},
			{
				"/agent/runs": () => json({ id: "agent-run-1", status: "running" }),
				"/agent/runs/agent-run-1": () =>
					json(completedAgentRun({ output: { structured: { email: null } } })),
			},
		);
		const noEmail = await exaAgentEmailProvider.run(
			{ name: "Nobody Found", domain: "acme.com" },
			findymailEnv(),
		);

		globalThis.fetch = fakeVendors(
			{},
			{ "/agent/runs": () => new Response(null, { status: 429 }) },
		);
		const rateLimited = await exaAgentEmailProvider.run(
			{ name: "Someone", domain: "acme.com" },
			findymailEnv(),
		);

		expect(noEmail).toBeNull();
		expect(rateLimited).toBeNull();
	});

	it("keeps polling a run it already paid for through a rate-limited poll, rather than failing the caller", async () => {
		let polls = 0;
		globalThis.fetch = fakeVendors(
			{},
			{
				"/agent/runs": () => json({ id: "agent-run-1", status: "running" }),
				"/agent/runs/agent-run-1": () => {
					polls += 1;
					if (polls === 1) return new Response(null, { status: 429 });
					return json(
						completedAgentRun({
							output: { structured: { email: "found@acme.com" } },
						}),
					);
				},
			},
		);

		const result = await exaAgentEmailProvider.run(
			{ name: "Someone", domain: "acme.com" },
			findymailEnv(),
		);

		expect(polls).toBeGreaterThan(1);
		expect(result?.contact?.email).toBe("found@acme.com");
	}, 20000);

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

describe("exaAgentEmailProvider: shape checks on what an agent reports", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	async function reportedContact(structured: {
		email: string;
		linkedinUrl?: string;
	}) {
		globalThis.fetch = fakeVendors(
			{},
			{
				"/agent/runs": () => json({ id: "agent-run-1", status: "running" }),
				"/agent/runs/agent-run-1": () =>
					json(completedAgentRun({ output: { structured } })),
			},
		);
		return exaAgentEmailProvider.run(
			{ name: "Someone", domain: "acme.com" },
			findymailEnv(),
		);
	}

	it("drops a linkedin url the agent invented, but keeps one that is a real linkedin profile", async () => {
		const invented = await reportedContact({
			email: "found@acme.com",
			linkedinUrl: "https://acme.com/team/someone",
		});
		const real = await reportedContact({
			email: "found@acme.com",
			linkedinUrl: "https://www.linkedin.com/in/someone",
		});

		expect(invented?.contact?.linkedin_url).toBeUndefined();
		expect(real?.contact?.linkedin_url).toBe(
			"https://www.linkedin.com/in/someone",
		);
	});

	it("misses rather than reporting an address that is not an email", async () => {
		const result = await reportedContact({ email: "contact us at acme" });

		expect(result).toBeNull();
	});
});
