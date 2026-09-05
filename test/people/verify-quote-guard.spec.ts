import { describe, expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import type { CompanyLoopContext } from "@/workflows/find-people-company";
import { runOneCompany } from "@/workflows/find-people-company";
import { fakeSecretEnv } from "../support/env";
import { stubClayFetch } from "../support/fetch";
import { fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	CONFIRMED_VERDICT,
	cleanupPeopleRun,
	JORDAN_BLAKE_ROSTER_ROW,
	personRowsFor,
	type SeededPeopleRun,
	seedPeopleRun,
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

function missingQuoteOverrides(
	domain: string,
	indexOverride: [string, unknown],
	profileOverride?: [string, unknown],
): Map<string, unknown> {
	const overrides = new Map<string, unknown>([
		selectOverride(domain, [
			{ candidate: jordan, basis: "explicit_persona_match" },
		]),
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
			{ found: false, reason: "missing", costEntries: [] },
		],
		indexOverride,
	]);
	if (profileOverride) overrides.set(profileOverride[0], profileOverride[1]);
	return overrides;
}

describe("FindPeopleWorkflow: a first-party quote missing from the page", () => {
	it("verifies through the second opinion when the index confirms the same employer", async () => {
		const domain = `quote-missing-agree-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("quote-missing-agree");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const overrides = missingQuoteOverrides(domain, [
				`people-${domain}-verify-0-index`,
				{
					found: true,
					employer: "Verify Target Co",
					employerCompanyId: null,
					reply: "{}",
					costEntries: [],
				},
			]);
			overrides.set(`people-${domain}-verify-0-agree`, {
				label: "SAME",
				reply: { employer: "SAME" },
				costEntries: [],
			});

			const result = await runOneCompany(
				contextFor(seed, overrides),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(1);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});

	it("does not verify when the second opinion also cannot place the candidate at the target company", async () => {
		const domain = `quote-missing-drop-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("quote-missing-drop");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const overrides = missingQuoteOverrides(
				domain,
				[
					`people-${domain}-verify-0-index`,
					{
						found: false,
						employer: null,
						employerCompanyId: null,
						reply: "{}",
						costEntries: [],
					},
				],
				[
					`people-${domain}-verify-0-profile`,
					{
						employment: "UNKNOWN",
						reply: { employment: "UNKNOWN", title: null, since: null },
						costEntries: [],
					},
				],
			);

			const result = await runOneCompany(
				contextFor(seed, overrides),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(0);
			expect(await personRowsFor(seed.org.id)).toHaveLength(0);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

describe("FindPeopleWorkflow: a first-party quote check that fails to crawl", () => {
	it("leaves the verdict verified without falling to a second opinion", async () => {
		const domain = `quote-crawl-error-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("quote-crawl-error");
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
						run: { status: "completed", output: CONFIRMED_VERDICT },
						costEntries: [],
					},
				],
				[
					`people-${domain}-verify-0-quote`,
					{ found: false, reason: "CRAWL_UNKNOWN_ERROR", costEntries: [] },
				],
			]);
			const workflowStep = fakeWorkflowStep(overrides);
			const ctx: CompanyLoopContext = {
				...contextFor(seed, overrides),
				step: workflowStep.step,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(1);
			expect(workflowStep.calls).not.toContain(
				`people-${domain}-verify-0-index`,
			);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
