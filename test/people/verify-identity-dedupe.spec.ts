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
	evidenceRowsFor,
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

function confirmedPickOverrides(
	domain: string,
	count: number,
): Array<[string, unknown]> {
	const overrides: Array<[string, unknown]> = [];
	for (let i = 0; i < count; i++) {
		overrides.push([
			`people-${domain}-verify-${i}-start`,
			{ id: `agent-run-${i}` },
		]);
		overrides.push([
			`people-${domain}-verify-${i}-poll-1`,
			{
				run: { status: "completed", output: CONFIRMED_VERDICT },
				costEntries: [],
			},
		]);
		overrides.push([
			`people-${domain}-verify-${i}-quote`,
			{ found: true, reason: "found", costEntries: [] },
		]);
	}
	return overrides;
}

type ThreeCandidates = [
	ReturnType<typeof verifyCandidate>,
	ReturnType<typeof verifyCandidate>,
	ReturnType<typeof verifyCandidate>,
];

function tiffanyMasseVariants(): ThreeCandidates {
	const title = "Regional Operations Manager";
	return [
		verifyCandidate(
			0,
			"Tiffany Masse",
			title,
			"https://linkedin.com/in/tiffany-masse-968691358",
		),
		verifyCandidate(
			1,
			"Tiffany Masse",
			title,
			"https://linkedin.com/in/tiffany-masse-3610a1375",
		),
		verifyCandidate(
			2,
			"Tiffany Masse",
			title,
			"https://linkedin.com/in/tiffany-masse-96b17036",
		),
	];
}

describe("FindPeopleWorkflow: three LinkedIn URL variants for one person", () => {
	it("delivers one person and records the other two URLs as person-alias evidence", async () => {
		const domain = `linkedin-variants-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("linkedin-variants");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const [tiffanyA, tiffanyB, tiffanyC] = tiffanyMasseVariants();
			const overrides = new Map<string, unknown>([
				selectOverride(domain, [
					{ candidate: tiffanyA, basis: "explicit_persona_match" },
					{ candidate: tiffanyB, basis: "explicit_persona_match" },
					{ candidate: tiffanyC, basis: "explicit_persona_match" },
				]),
				...confirmedPickOverrides(domain, 3),
			]);

			const result = await runOneCompany(
				contextFor(seed, overrides),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(1);
			const people = await personRowsFor(seed.org.id);
			expect(people).toHaveLength(1);
			expect(people[0]?.linkedinUrl).toBe(tiffanyA.url);

			const aliasRows = (await evidenceRowsFor(people[0]?.id ?? "")).filter(
				(row) => row.kind === "person-alias",
			);
			expect(aliasRows).toHaveLength(2);
			const aliasUrls = aliasRows
				.map((row) => JSON.parse(row.value).body.url)
				.sort();
			expect(aliasUrls).toEqual([tiffanyB.url, tiffanyC.url].sort());
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

describe("FindPeopleWorkflow: same name at the same company, different titles", () => {
	it("delivers both people rather than merging them into one", async () => {
		const domain = `same-name-diff-title-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("same-name-diff-title");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const operations = verifyCandidate(
				0,
				"Jordan Blake",
				"Regional Operations Manager",
				"https://linkedin.com/in/jordan-blake-ops",
			);
			const sales = verifyCandidate(
				1,
				"Jordan Blake",
				"VP Sales",
				"https://linkedin.com/in/jordan-blake-sales",
			);
			const overrides = new Map<string, unknown>([
				selectOverride(domain, [
					{ candidate: operations, basis: "explicit_persona_match" },
					{ candidate: sales, basis: "explicit_persona_match" },
				]),
				...confirmedPickOverrides(domain, 2),
			]);

			const result = await runOneCompany(
				contextFor(seed, overrides),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(2);
			expect(await personRowsFor(seed.org.id)).toHaveLength(2);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});

describe("FindPeopleWorkflow: the same canonical LinkedIn URL picked twice", () => {
	it("delivers one person for the shared URL", async () => {
		const domain = `same-url-twice-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("same-url-twice");
		try {
			stubClayFetch([JORDAN_BLAKE_ROSTER_ROW]);
			const first = verifyCandidate(
				0,
				"Casey Doe",
				"Director Sales",
				"https://www.linkedin.com/in/casey-doe/",
			);
			const second = verifyCandidate(
				1,
				"Casey Doe",
				"Director Sales",
				"https://linkedin.com/in/casey-doe",
			);
			const overrides = new Map<string, unknown>([
				selectOverride(domain, [
					{ candidate: first, basis: "explicit_persona_match" },
					{ candidate: second, basis: "explicit_persona_match" },
				]),
				...confirmedPickOverrides(domain, 2),
			]);

			const result = await runOneCompany(
				contextFor(seed, overrides),
				bareCompany(domain),
				0,
			);

			expect(result.outcome.verified).toBe(1);
			expect(await personRowsFor(seed.org.id)).toHaveLength(1);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
