import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import type { CompanyLoopContext } from "@/workflows/find-people-company";
import { runCompanies, runOneCompany } from "@/workflows/find-people-company";
import { fakeSecretEnv } from "../support/env";
import { stubClayFetch } from "../support/fetch";
import { fakeWorkflowStep } from "../support/step";
import {
	AGGREGATOR_CONFIRMED_VERDICT,
	bareCompany,
	CONFIRMED_VERDICT,
	cleanupPeopleRun,
	evidenceRowsFor,
	JORDAN_BLAKE_ROSTER_ROW,
	personRowsFor,
	runCompanyRowsFor,
	type SeededPeopleRun,
	seedPeopleRun,
	UNKNOWN_VERDICT_WITH_URL,
	verifyCandidate,
} from "./support";

function contextFor(
	seed: SeededPeopleRun,
	overrides: Map<string, unknown>,
): CompanyLoopContext {
	return {
		env: fakeSecretEnv({ CLAY_API_KEY: "test-clay-key" }),
		step: fakeWorkflowStep(overrides).step,
		runId: seed.runId,
		organizationId: seed.org.id,
		buyer: resolveBuyer({ target: "the sales leaders", profile: null }),
		profile: null,
	};
}

type Pick = { candidate: ReturnType<typeof verifyCandidate>; basis: string };

function selectOverride(domain: string, picks: Pick[]): [string, unknown] {
	return [
		`people-${domain}-select`,
		{
			picks,
			droppedIds: [],
			reply: { picks: picks.map((pick, i) => ({ id: i, basis: pick.basis })) },
			costDollars: 0.01,
		},
	];
}

const jordan = verifyCandidate(
	0,
	"Jordan Blake",
	"VP Sales",
	"https://linkedin.com/in/jordan-blake",
);

function pollErrorOverrides(
	domainA: string,
	domainB: string,
): Map<string, unknown> {
	const casey = verifyCandidate(
		1,
		"Casey Doe",
		"Director Sales",
		"https://linkedin.com/in/casey-doe",
	);
	return new Map<string, unknown>([
		selectOverride(domainA, [
			{ candidate: jordan, basis: "explicit_persona_match" },
			{ candidate: casey, basis: "inferred_workflow_owner" },
		]),
		[`people-${domainA}-verify-0-start`, { id: "agent-run-0" }],
		[
			`people-${domainA}-verify-0-poll-1`,
			new NonRetryableError("verify agent run exhausted its poll budget"),
		],
		[`people-${domainA}-verify-1-start`, { id: "agent-run-1" }],
		[
			`people-${domainA}-verify-1-poll-1`,
			{
				run: { status: "completed", output: CONFIRMED_VERDICT },
				costEntries: [],
			},
		],
		[
			`people-${domainA}-verify-1-quote`,
			{ found: true, reason: "found", costEntries: [] },
		],
		selectOverride(domainB, []),
	]);
}

describe("FindPeopleWorkflow: a pick whose poll step fails", () => {
	it("drops that pick, keeps the company's other picks, and lets the run continue to the next company", async () => {
		const domainA = `poll-error-a-${crypto.randomUUID()}.example`;
		const domainB = `poll-error-b-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("poll-error");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const ctx = contextFor(seed, pollErrorOverrides(domainA, domainB));

			const result = await runCompanies(
				ctx,
				[bareCompany(domainA), bareCompany(domainB)],
				0,
			);

			expect(result.companiesSearched).toBe(2);
			expect(result.peopleVerified).toBe(1);

			const domainARow = (await runCompanyRowsFor(seed.runId)).find(
				(row) => row.domain === domainA,
			);
			if (!domainARow)
				throw new Error("expected a run_company row for the failing domain");
			const evidenceRows = await evidenceRowsFor(domainARow.id);
			expect(evidenceRows.some((row) => row.kind === "verify-error")).toBe(
				true,
			);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

describe("FindPeopleWorkflow: an unknown verdict's reported URL", () => {
	it("keeps the agent's reported evidence_url on the stored verdict even though the pick is not verified", async () => {
		const domain = `unknown-url-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("unknown-url");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const overrides = new Map<string, unknown>([
				selectOverride(domain, [
					{ candidate: jordan, basis: "explicit_persona_match" },
				]),
				[`people-${domain}-verify-0-start`, { id: "agent-run-0" }],
				[
					`people-${domain}-verify-0-poll-1`,
					{
						run: { status: "completed", output: UNKNOWN_VERDICT_WITH_URL },
						costEntries: [],
					},
				],
			]);

			const result = await runOneCompany(
				contextFor(seed, overrides),
				bareCompany(domain),
				0,
			);
			expect(result.outcome.verified).toBe(0);

			const runCompanyRow = (await runCompanyRowsFor(seed.runId))[0];
			if (!runCompanyRow) throw new Error("expected a run_company row");
			const pollRow = (await evidenceRowsFor(runCompanyRow.id)).find(
				(row) => row.kind === "verify-poll",
			);
			if (!pollRow) throw new Error("expected a verify-poll evidence row");
			expect(JSON.parse(pollRow.value ?? "").evidence_url).toBe(
				UNKNOWN_VERDICT_WITH_URL.evidence_url,
			);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

function wrongCompanyOverrides(domain: string): Map<string, unknown> {
	return new Map<string, unknown>([
		selectOverride(domain, [
			{ candidate: jordan, basis: "explicit_persona_match" },
		]),
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
			{ label: "DIFFERENT", reply: { employer: "DIFFERENT" }, costEntries: [] },
		],
		[
			`people-${domain}-verify-0-profile`,
			{
				employment: "UNKNOWN",
				reply: { employment: "UNKNOWN", title: null, since: null },
				costEntries: [],
			},
		],
	]);
}

describe("FindPeopleWorkflow: a roster candidate who works elsewhere", () => {
	it("does not verify a candidate the second opinion places at a different company and the profile rescue cannot confirm", async () => {
		const domain = `wrong-company-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("wrong-company");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);

			const result = await runOneCompany(
				contextFor(seed, wrongCompanyOverrides(domain)),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(0);
			expect(await personRowsFor(seed.org.id)).toHaveLength(0);

			const runCompanyRow = (await runCompanyRowsFor(seed.runId))[0];
			if (!runCompanyRow) throw new Error("expected a run_company row");
			const evidenceRows = await evidenceRowsFor(runCompanyRow.id);
			const agreeRow = evidenceRows.find((row) => row.kind === "verify-agree");
			if (!agreeRow) throw new Error("expected verify-agree evidence");
			expect(JSON.parse(agreeRow.value)).toEqual({ employer: "DIFFERENT" });
			const profileRow = evidenceRows.find(
				(row) => row.kind === "verify-profile",
			);
			if (!profileRow) throw new Error("expected verify-profile evidence");
			expect(JSON.parse(profileRow.value)).toEqual({
				employment: "UNKNOWN",
				title: null,
				since: null,
			});
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
