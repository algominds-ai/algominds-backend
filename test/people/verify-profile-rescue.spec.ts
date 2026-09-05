import { describe, expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import type { CompanyLoopContext } from "@/workflows/find-people-company";
import { runOneCompany } from "@/workflows/find-people-company";
import { fakeSecretEnv } from "../support/env";
import { stubClayFetch } from "../support/fetch";
import { fakeWorkflowStep } from "../support/step";
import {
	AGGREGATOR_CONFIRMED_VERDICT,
	bareCompany,
	cleanupPeopleRun,
	evidenceRowsFor,
	JORDAN_BLAKE_ROSTER_ROW,
	personRowsFor,
	runCompanyRowsFor,
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

const jordan = verifyCandidate(
	0,
	"Jordan Blake",
	"VP Sales",
	"https://linkedin.com/in/jordan-blake",
);

function indexMissOverrides(
	domain: string,
	employment: "CURRENT" | "LEFT",
): Map<string, unknown> {
	const overrides = new Map<string, unknown>([
		[
			`people-${domain}-select`,
			{
				picks: [{ candidate: jordan, basis: "explicit_persona_match" }],
				droppedIds: [],
				reply: { picks: [{ id: 0, basis: "explicit_persona_match" }] },
				costDollars: 0.01,
			},
		],
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
				employment,
				reply: {
					employment,
					title: employment === "CURRENT" ? "VP Sales" : null,
					since: employment === "CURRENT" ? "2024-01" : null,
				},
				costEntries: [],
			},
		],
	]);
	if (employment === "CURRENT") {
		overrides.set(`people-${domain}-verify-0-quote`, {
			found: true,
			reason: "found",
			costEntries: [],
		});
	}
	return overrides;
}

describe("FindPeopleWorkflow: an index miss resolved by the candidate's own profile", () => {
	it("verifies the pick when the profile shows them currently at the target company", async () => {
		const domain = `profile-current-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("profile-current");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);

			const result = await runOneCompany(
				contextFor(seed, indexMissOverrides(domain, "CURRENT")),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(1);
			const storedPeople = await personRowsFor(seed.org.id);
			const jordanBlake = storedPeople.find(
				(row) => row.linkedinUrl === jordan.url,
			);
			if (!jordanBlake) throw new Error("expected jordan blake to be verified");
			const profileRow = (await evidenceRowsFor(jordanBlake.id)).find(
				(row) => row.kind === "verify-profile",
			);
			if (!profileRow) throw new Error("expected verify-profile evidence");
			expect(JSON.parse(profileRow.value).body).toEqual({
				employment: "CURRENT",
				title: "VP Sales",
				since: "2024-01",
			});
		} finally {
			await cleanupPeopleRun(seed);
		}
	});

	it("does not verify the pick when the profile shows them gone from the target company", async () => {
		const domain = `profile-left-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("profile-left");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);

			const result = await runOneCompany(
				contextFor(seed, indexMissOverrides(domain, "LEFT")),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(0);
			expect(await personRowsFor(seed.org.id)).toHaveLength(0);
			const runCompanyRow = (await runCompanyRowsFor(seed.runId))[0];
			if (!runCompanyRow) throw new Error("expected a run_company row");
			const profileRow = (await evidenceRowsFor(runCompanyRow.id)).find(
				(row) => row.kind === "verify-profile",
			);
			if (!profileRow) throw new Error("expected verify-profile evidence");
			expect(JSON.parse(profileRow.value).employment).toBe("LEFT");
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
