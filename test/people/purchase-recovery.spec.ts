import { env as testEnv } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { findRun } from "@/core/db/queries";
import { resolveBuyer } from "@/core/people/buyer";
import {
	type CompanyLoopContext,
	runOneCompany,
} from "@/workflows/find-people-company";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";
import { fakePeopleVendors } from "../support/people";
import { fakeRetryingWorkflowStep, fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	cleanupPeopleRun,
	evidenceRowsFor,
	personRowsFor,
	runCompanyRowsFor,
	type SeededPeopleRun,
	seedPeopleRun,
} from "./support";

const originalFetch = globalThis.fetch;
const seeds: SeededPeopleRun[] = [];
afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const seed of seeds) await cleanupPeopleRun(seed);
	seeds.length = 0;
});

async function context(
	label: string,
	overrides: Map<string, unknown>,
): Promise<CompanyLoopContext> {
	const seed = await seedPeopleRun(label);
	seeds.push(seed);
	return {
		env: fakeModelEnv(
			{},
			fakeSecretEnv({ EXA_API_KEY: "test", CLAY_API_KEY: "test" }),
		),
		step: fakeWorkflowStep(overrides).step,
		runId: seed.runId,
		organizationId: seed.org.id,
		buyer: resolveBuyer({ target: "Founder/CEO", profile: null }),
	};
}

const company = {
	...bareCompany("example.com"),
	name: "Example",
	exaId: "exact-employer",
};
const rows = [
	{
		name: "Alex Doe",
		title: "Founder",
		company: "Example",
		url: "https://linkedin.com/in/alex",
		location: null,
		since: null,
	},
];
const partialClay = {
	value: {
		rows,
		raw: [],
		quotaUsed: 1,
		rejected: false,
		capped: true,
		error: "Later Clay page unavailable",
	},
	costDollars: 0,
	error: null,
};

it("cancels the known agent run after its start bank fails without another paid start", async () => {
	const ctx = await context(
		"start-bank",
		new Map([
			[
				"people-example.com-research-0-start-bank",
				new Error("Database bank unavailable"),
			],
		]),
	);
	const vendors = fakePeopleVendors(rows, { searchUnresolvedIds: [0] });
	globalThis.fetch = vendors.fetch;
	const result = await runOneCompany(ctx, company, 0);
	expect(result.outcome).toMatchObject({ verified: 0, capped: true });
	expect(
		vendors.calls.filter((url) => url.endsWith("/agent/runs")),
	).toHaveLength(1);
	expect(vendors.calls).toContain(
		"https://api.exa.ai/agent/runs/agent-0/cancel",
	);
	expect(result.costDollars).toBeCloseTo(0.042);
	expect((await findRun(testEnv, ctx.runId))?.costDollars).toBeCloseTo(0.042);
	const [stored] = await runCompanyRowsFor(ctx.runId);
	const evidence = await evidenceRowsFor(stored?.id ?? "");
	expect(
		evidence.some(
			(row) =>
				row.kind === "research-settlement" &&
				row.value.includes('"terminal":true'),
		),
	).toBe(true);
	expect(evidence.some((row) => row.kind.includes("billing-unknown"))).toBe(
		false,
	);
});

it("researches retained rows and runs one fallback after a later Clay page fails", async () => {
	const ctx = await context(
		"later-page",
		new Map([["people-example.com-clay", partialClay]]),
	);
	const vendors = fakePeopleVendors(rows);
	globalThis.fetch = vendors.fetch;
	const result = await runOneCompany(ctx, company, 0);
	expect(result.outcome).toMatchObject({ verified: 1, capped: true });
	expect(await personRowsFor(ctx.organizationId)).toHaveLength(1);
	const [stored] = await runCompanyRowsFor(ctx.runId);
	const evidence = await evidenceRowsFor(stored?.id ?? "");
	expect(
		evidence.some(
			(row) =>
				row.kind === "roster" &&
				row.value.includes("Later Clay page unavailable"),
		),
	).toBe(true);
	expect(
		evidence.some((row) => row.value.includes('"costDollars":0.005')),
	).toBe(true);
	expect(vendors.calls.filter((url) => url.endsWith("/search"))).toHaveLength(
		2,
	);
});

it("persists retained Clay roster rows when the fallback for incomplete paging fails", async () => {
	const ctx = await context(
		"fallback-failure",
		new Map<string, unknown>([
			["people-example.com-clay", partialClay],
			[
				"people-example.com-fallback",
				{
					value: null,
					costDollars: 0.005,
					error: "Exa fallback unavailable",
				},
			],
		]),
	);
	ctx.buyer = resolveBuyer({ target: null, profile: null });
	globalThis.fetch = fakePeopleVendors(rows).fetch;
	const result = await runOneCompany(ctx, company, 0);
	expect(result.outcome).toMatchObject({
		roster: 1,
		verified: 0,
		capped: true,
	});
	expect(await personRowsFor(ctx.organizationId)).toHaveLength(1);
	const [stored] = await runCompanyRowsFor(ctx.runId);
	expect(
		(await evidenceRowsFor(stored?.id ?? "")).some(
			(row) =>
				row.kind === "fallback-error" &&
				row.value.includes("Exa fallback unavailable"),
		),
	).toBe(true);
});

it("banks a failed Clay purchase before one bounded fallback", async () => {
	const ctx = await context(
		"clay-failure",
		new Map([
			[
				"people-example.com-clay",
				{ value: null, costDollars: 0.017, error: "Clay unavailable" },
			],
		]),
	);
	const vendors = fakePeopleVendors([]);
	globalThis.fetch = vendors.fetch;
	const result = await runOneCompany(ctx, company, 0);
	expect(result.outcome).toMatchObject({ verified: 0, capped: true });
	expect(result.costDollars).toBeCloseTo(0.022);
	expect((await findRun(testEnv, ctx.runId))?.costDollars).toBeCloseTo(0.022);
	expect(vendors.calls.filter((url) => url.endsWith("/search"))).toHaveLength(
		1,
	);
});

async function researchOutcome(decision: "rejected" | "unresolved" | null) {
	const candidate = rows[0];
	if (!candidate) throw new Error("Missing candidate");
	const roleStatus = decision === "rejected" ? "supported" : "unresolved";
	const buyerFit = decision === "rejected" ? "unrelated" : "unresolved";
	const reason =
		decision === "rejected"
			? "Established responsibility mismatch"
			: "Research completed; current employer remains unproven";
	const ctx = await context(
		decision ?? "missing-decision",
		new Map([
			[
				"people-example.com-research-0-poll-0",
				{
					value: {
						status: "completed",
						output: {
							people: decision
								? [
										{
											id: 0,
											decision,
											identityStatus: "supported",
											currentEmployerStatus: roleStatus,
											currentRoleStatus: roleStatus,
											buyerFit,
											reason,
											name: candidate.name,
											title: candidate.title,
											linkedinUrl: candidate.url,
											roleEvidence: null,
										},
									]
								: [],
						},
					},
					costDollars: 0.1,
					error: null,
				},
			],
		]),
	);
	const vendors = fakePeopleVendors(rows, { searchUnresolvedIds: [0] });
	globalThis.fetch = vendors.fetch;
	const result = await runOneCompany(ctx, company, 0);
	const [stored] = await runCompanyRowsFor(ctx.runId);
	const evidence = await evidenceRowsFor(stored?.id ?? "");
	return {
		result,
		calls: vendors.calls,
		completeness:
			evidence.find((row) => row.kind === "completeness")?.value ?? "",
	};
}

it("keeps an absent final decision capped and unprocessed", async () => {
	const result = await researchOutcome(null);
	expect(result.result.outcome).toMatchObject({ verified: 0, capped: true });
	expect(result.completeness).toContain('"checked":0');
	expect(result.completeness).toContain('"unprocessed":1');
	expect(result.calls.some((url) => url.endsWith("/contents"))).toBe(false);
});

it("finishes a completed responsibility rejection without source purchases", async () => {
	const result = await researchOutcome("rejected");
	expect(result.result.outcome).toMatchObject({ verified: 0, capped: false });
	expect(result.completeness).toContain('"checked":1');
	expect(result.completeness).toContain('"unprocessed":0');
	expect(
		result.calls.filter((url) => url.endsWith("/chat/completions")),
	).toHaveLength(0);
	expect(result.calls.some((url) => url.endsWith("/contents"))).toBe(false);
});

it("counts an explicit unresolved final decision as evaluated without verifying it", async () => {
	const result = await researchOutcome("unresolved");
	expect(result.result.outcome).toMatchObject({ verified: 0, capped: false });
	expect(result.completeness).toContain('"checked":1');
	expect(result.completeness).toContain('"unprocessed":0');
});

it("retries a temporary status read failure and delivers from the single paid start", async () => {
	const ctx = await context("poll-retry", new Map());
	ctx.step = fakeRetryingWorkflowStep().step;
	const vendors = fakePeopleVendors(rows, {
		pollFailures: 1,
		searchUnresolvedIds: [0],
	});
	globalThis.fetch = vendors.fetch;
	const result = await runOneCompany(ctx, company, 0);
	expect(result.outcome).toMatchObject({ verified: 1, capped: false });
	expect(await personRowsFor(ctx.organizationId)).toHaveLength(1);
	expect(
		vendors.calls.filter((url) => url.endsWith("/agent/runs")),
	).toHaveLength(1);
	expect(
		vendors.calls.filter((url) => url.endsWith("/agent/runs/agent-0")),
	).toHaveLength(2);
	expect(vendors.calls.some((url) => url.endsWith("/cancel"))).toBe(false);
	expect((await findRun(testEnv, ctx.runId))?.costDollars).toBeCloseTo(
		result.costDollars,
	);
	const [stored] = await runCompanyRowsFor(ctx.runId);
	expect(
		(await evidenceRowsFor(stored?.id ?? "")).some(
			(row) =>
				row.kind === "research-0-poll-0" &&
				row.value.includes('"costDollars":0.1'),
		),
	).toBe(true);
});
