import { describe, expect, it } from "vitest";
import { config } from "@/config";
import type { Person } from "@/core/db/schema";
import { resolveBuyer } from "@/core/people/buyer";
import type { CompanyLoopContext } from "@/workflows/find-people-company";
import { runOneCompany } from "@/workflows/find-people-company";
import { fakeSecretEnv } from "../support/env";
import { stubClayFetch } from "../support/fetch";
import { fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	CONFIRMED_VERDICT,
	CONTRADICTED_VERDICT,
	cleanupPeopleRun,
	evidenceRowsFor,
	JORDAN_BLAKE_ROSTER_ROW,
	personRowsFor,
	runCompanyRowsFor,
	type SeededPeopleRun,
	seedPeopleRun,
	UNKNOWN_VERDICT,
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

function pollOverride(
	domain: string,
	index: number,
	output: unknown,
): [string, unknown] {
	return [
		`people-${domain}-verify-${index}-poll-1`,
		{ run: { status: "completed", output }, costEntries: [] },
	];
}

const jordan = verifyCandidate(
	0,
	"Jordan Blake",
	"VP Sales",
	"https://linkedin.com/in/jordan-blake",
);
const casey = verifyCandidate(
	1,
	"Casey Doe",
	"Director Sales",
	"https://linkedin.com/in/casey-doe",
);

function verifiedTargetOverrides(domain: string): Map<string, unknown> {
	return new Map<string, unknown>([
		selectOverride(domain, [
			{ candidate: jordan, basis: "explicit_persona_match" },
			{ candidate: casey, basis: "inferred_workflow_owner" },
		]),
		[`people-${domain}-verify-0-start`, { id: "agent-run-0" }],
		pollOverride(domain, 0, CONFIRMED_VERDICT),
		[
			`people-${domain}-verify-0-quote`,
			{ found: true, reason: "found", costEntries: [] },
		],
		[`people-${domain}-verify-1-start`, { id: "agent-run-1" }],
		pollOverride(domain, 1, UNKNOWN_VERDICT),
	]);
}

describe("FindPeopleWorkflow: a target run", () => {
	it("stores only verified target picks and all replies", async () => {
		const domain = `verify-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("verify");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);

			const result = await runOneCompany(
				contextFor(seed, verifiedTargetOverrides(domain)),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(1);
			const storedPeople = await personRowsFor(seed.org.id);
			const jordanBlake = storedPeople.find(
				(row: Person) => row.linkedinUrl === jordan.url,
			);
			if (!jordanBlake) throw new Error("expected jordan blake to be verified");
			expect(
				storedPeople.some((row: Person) => row.linkedinUrl === casey.url),
			).toBe(false);

			const runCompanyRow = (await runCompanyRowsFor(seed.runId))[0];
			if (!runCompanyRow) throw new Error("expected a run_company row");
			const quoteRows = (await evidenceRowsFor(jordanBlake.id)).filter(
				(row) => row.kind === "verify-quote",
			);
			expect(quoteRows).toHaveLength(1);
			expect(JSON.parse(quoteRows[0]?.value ?? "")).toEqual({
				runCompanyId: runCompanyRow.id,
				body: {
					url: "https://news.example/jordan-blake-joins-as-vp-sales",
					found: true,
					reason: "found",
				},
			});
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

function boundOverrides(
	domain: string,
	pickCount: number,
): Map<string, unknown> {
	const picks: Pick[] = Array.from({ length: pickCount }, (_, index) => ({
		candidate: verifyCandidate(
			index,
			`Person ${index}`,
			"VP Sales",
			`https://linkedin.com/in/bound-person-${index}`,
		),
		basis: "explicit_persona_match",
	}));
	const overrides = new Map<string, unknown>([selectOverride(domain, picks)]);
	for (let index = 0; index < config.people.maxVerifyPerCompany; index++) {
		overrides.set(`people-${domain}-verify-${index}-start`, {
			id: `agent-run-${index}`,
		});
		const [name, value] = pollOverride(domain, index, CONFIRMED_VERDICT);
		overrides.set(name, value);
		overrides.set(`people-${domain}-verify-${index}-quote`, {
			found: true,
			reason: "found",
			costEntries: [],
		});
	}
	return overrides;
}

describe("FindPeopleWorkflow: the maxVerifyPerCompany bound", () => {
	it("verifies every rubric match up to the bound and never starts a verify run past it", async () => {
		const domain = `bound-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("bound");
		const bound = config.people.maxVerifyPerCompany;
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const workflowStep = fakeWorkflowStep(boundOverrides(domain, bound + 3));
			const ctx: CompanyLoopContext = {
				...contextFor(seed, new Map()),
				step: workflowStep.step,
			};

			const result = await runOneCompany(ctx, bareCompany(domain), 0);

			expect(result.outcome.verified).toBe(bound);
			expect(workflowStep.calls).not.toContain(
				`people-${domain}-verify-${bound}-start`,
			);
			expect(await personRowsFor(seed.org.id)).toHaveLength(bound);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

describe("FindPeopleWorkflow: a contradicted verdict", () => {
	it("stores no person for a candidate the agent contradicts", async () => {
		const domain = `contradicted-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("contradicted");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const overrides = new Map<string, unknown>([
				selectOverride(domain, [
					{ candidate: jordan, basis: "explicit_persona_match" },
				]),
				[`people-${domain}-verify-0-start`, { id: "agent-run-0" }],
				pollOverride(domain, 0, CONTRADICTED_VERDICT),
			]);

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

describe("FindPeopleWorkflow: a null selector reply", () => {
	it("picks nobody but still records one select evidence row", async () => {
		const domain = `null-select-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("null-select");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const overrides = new Map<string, unknown>([
				[
					`people-${domain}-select`,
					{ picks: [], droppedIds: [], reply: null, costDollars: 0 },
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
			const selectRows = (await evidenceRowsFor(runCompanyRow.id)).filter(
				(row) => row.kind === "select",
			);
			expect(selectRows).toHaveLength(1);
			expect(selectRows[0]?.value).toBe("null");
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
