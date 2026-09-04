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

function contextFor(seed: SeededPeopleRun): CompanyLoopContext {
	return {
		env: fakeSecretEnv({ CLAY_API_KEY: "test-clay-key" }),
		step: fakeWorkflowStep().step,
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

const ORGANIZATION_ID = "https://exa.ai/library/organization/acme";

function organizationIdOverrides(
	domain: string,
	employerCompanyId: string,
): Map<string, unknown> {
	return new Map<string, unknown>([
		[
			`people-${domain}-organization`,
			{ organizationId: ORGANIZATION_ID, costEntries: [] },
		],
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
				found: true,
				employer: "Acme Holdings",
				employerCompanyId,
				reply: "{}",
				costEntries: [],
			},
		],
		[
			`people-${domain}-verify-0-quote`,
			{ found: true, reason: "found", costEntries: [] },
		],
	]);
}

describe("FindPeopleWorkflow: the index second opinion agrees by organization id", () => {
	it("verifies with no model call when both organization ids match", async () => {
		const domain = `org-agree-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("org-agree");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const workflowStep = fakeWorkflowStep(
				organizationIdOverrides(domain, ORGANIZATION_ID),
			);
			const ctx: CompanyLoopContext = {
				...contextFor(seed),
				step: workflowStep.step,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(1);
			expect(workflowStep.calls).not.toContain(
				`people-${domain}-verify-0-agree`,
			);
			const storedPeople = await personRowsFor(seed.org.id);
			const jordanBlake = storedPeople.find(
				(row) => row.linkedinUrl === jordan.url,
			);
			if (!jordanBlake) throw new Error("expected jordan blake to be verified");
			const agreeRow = (await evidenceRowsFor(jordanBlake.id)).find(
				(row) => row.kind === "verify-agree",
			);
			if (!agreeRow) throw new Error("expected verify-agree evidence");
			expect(JSON.parse(agreeRow.value).body).toEqual({
				employer: "SAME",
				byOrganizationId: true,
			});
		} finally {
			await cleanupPeopleRun(seed);
		}
	});

	it("does not verify, with no model call, when the organization ids differ", async () => {
		const domain = `org-differ-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("org-differ");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const workflowStep = fakeWorkflowStep(
				organizationIdOverrides(
					domain,
					"https://exa.ai/library/organization/other",
				),
			);
			const ctx: CompanyLoopContext = {
				...contextFor(seed),
				step: workflowStep.step,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(0);
			expect(workflowStep.calls).not.toContain(
				`people-${domain}-verify-0-agree`,
			);
			const runCompanyRow = (await runCompanyRowsFor(seed.runId))[0];
			if (!runCompanyRow) throw new Error("expected a run_company row");
			const agreeRow = (await evidenceRowsFor(runCompanyRow.id)).find(
				(row) => row.kind === "verify-agree",
			);
			if (!agreeRow) throw new Error("expected verify-agree evidence");
			expect(JSON.parse(agreeRow.value)).toEqual({
				employer: "DIFFERENT",
				byOrganizationId: true,
			});
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
