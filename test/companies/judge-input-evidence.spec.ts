import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import type {
	EvidenceByRow,
	RequirementEvidence,
} from "@/core/companies/judge-evidence";
import { PartialSpendError } from "@/core/cost";
import { db, withConnection } from "@/core/db/client";
import { evidence as evidenceTable } from "@/core/db/schema";
import { conditionRefs } from "@/core/requirements";
import { roundDeps } from "@/workflows/find-companies-agent";
import { profileFixture, requirementFixture } from "../support/icp";
import type { FakeWorkflowStep } from "../support/step";
import { fakeWorkflowStep } from "../support/step";

const ROUND = 1;

function companyRow(domain: string): CompanyRow {
	return {
		name: `Co ${domain}`,
		domain,
		linkedinUrl: null,
		record: null,
		description: "a description of the company",
	};
}

function requirements() {
	const page = requirementFixture(
		"the company runs the technology in production",
	);
	return [
		{
			...page,
			anyOf: [
				{
					allOf: [
						{
							text: "the company runs the technology in production",
							window: null,
							sourceRule: "company website",
						},
					],
				},
			],
		},
		requirementFixture("the company sells to mid-market buyers"),
	];
}

const requirementIds = conditionRefs(requirements()).map((ref) => ref.id);

function evidenceByRowFor(domain: string): EvidenceByRow {
	const perRow = new Map<string, RequirementEvidence>([
		[
			requirementIds[0] ?? "r1.a1.c1",
			{
				url: `https://${domain}/product`,
				quote: `${domain} runs it in production.`,
			},
		],
	]);
	return new Map([[0, perRow]]);
}

function judgeDepsFor(
	runId: string,
	harness: FakeWorkflowStep,
): ReturnType<typeof roundDeps>["judge"] {
	return roundDeps({
		accumulatedDomains: new Set(),
		remaining: 15,
		step: harness.step,
		round: ROUND,
		today: "2026-09-01",
		icp: profileFixture(),
		timings: [],
		runId,
	}).judge;
}

async function judgeInputRowsFor(subjectId: string) {
	const stored = await withConnection(testEnv, "direct", db, (connection) =>
		connection
			.select()
			.from(evidenceTable)
			.where(eq(evidenceTable.subjectId, subjectId)),
	);
	return stored.filter((row) => row.kind === "judge-input");
}

async function deleteEvidenceFor(subjectId: string): Promise<void> {
	await withConnection(testEnv, "direct", db, (connection) =>
		connection
			.delete(evidenceTable)
			.where(eq(evidenceTable.subjectId, subjectId)),
	);
}

type ParsedJudgeInput = {
	round: number;
	domain: string | null;
	fields: { name: string | null };
	requirements: ReturnType<typeof requirements>;
	evidence: Record<string, RequirementEvidence> | null;
};

function parseJudgeInput(value: string | null | undefined): ParsedJudgeInput {
	return JSON.parse(value ?? "{}");
}

describe("the round saves the judge's exact input before it calls the model", () => {
	it("stores a judge-input evidence row carrying the row's domain, fields and requirement flags", async () => {
		const runId = `judge-input-test-${crypto.randomUUID()}`;
		const domain = `judge-input-co-${crypto.randomUUID()}.example`;
		const harness = fakeWorkflowStep(
			new Map([
				[
					`round_${ROUND}-judge-0`,
					{
						outcome: { status: "completed", output: { verdicts: [] } },
						costEntries: [],
					},
				],
			]),
		);
		const judge = judgeDepsFor(runId, harness);

		try {
			await judge(requirements(), [companyRow(domain)], testEnv, {
				evidenceByRow: evidenceByRowFor(domain),
			});

			expect(harness.calls).toContain(`round_${ROUND}-judge-input`);
			const stored = await judgeInputRowsFor(runId);
			expect(stored).toHaveLength(1);
			const parsed = parseJudgeInput(stored[0]?.value);
			expect(parsed.round).toBe(ROUND);
			expect(parsed.domain).toBe(domain);
			expect(parsed.fields.name).toBe(`Co ${domain}`);
			expect(parsed.requirements).toEqual(requirements());
			expect(parsed.evidence?.[requirementIds[0] ?? ""]?.quote).toBe(
				`${domain} runs it in production.`,
			);
		} finally {
			await deleteEvidenceFor(runId);
		}
	});

	it("remaps cached slice-local indices to global row indices at the second slice", async () => {
		const runId = `judge-slices-${crypto.randomUUID()}`;
		const rows = Array.from({ length: 5 }, (_, index) =>
			companyRow(`slice-${index}.example`),
		);
		const cached = (index: number) => ({
			outcome: {
				status: "completed",
				output: {
					verdicts: [{ index, statuses: [], reason: "cached" }],
				},
			},
			costEntries: [],
		});
		const harness = fakeWorkflowStep(
			new Map<string, unknown>([
				[`round_${ROUND}-judge-0`, cached(0)],
				[`round_${ROUND}-judge-4`, cached(0)],
			]),
		);
		try {
			const result = await judgeDepsFor(runId, harness)(
				requirements(),
				rows,
				testEnv,
			);
			expect(result.verdicts.map((verdict) => verdict.index)).toEqual([0, 4]);
			expect(harness.calls).toContain(`round_${ROUND}-judge-4`);
		} finally {
			await deleteEvidenceFor(runId);
		}
	});

	it("propagates cached and failed slice spend without invoking a provider", async () => {
		const runId = `judge-slice-spend-${crypto.randomUUID()}`;
		const rows = Array.from({ length: 5 }, (_, index) =>
			companyRow(`spend-${index}.example`),
		);
		const harness = fakeWorkflowStep(
			new Map<string, unknown>([
				[
					`round_${ROUND}-judge-0`,
					{
						outcome: { status: "completed", output: { verdicts: [] } },
						costEntries: [{ provider: "test", op: "judge", dollars: 0.01 }],
					},
				],
				[
					`round_${ROUND}-judge-4`,
					new PartialSpendError(0.02, new Error("slice failed")),
				],
			]),
		);
		try {
			await expect(
				judgeDepsFor(runId, harness)(requirements(), rows, testEnv),
			).rejects.toMatchObject({ costDollars: 0.03 });
			expect(harness.calls).toContain(`round_${ROUND}-judge-0`);
			expect(harness.calls).toContain(`round_${ROUND}-judge-4`);
		} finally {
			await deleteEvidenceFor(runId);
		}
	});
});
