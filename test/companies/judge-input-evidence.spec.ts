import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import type {
	EvidenceByRow,
	RequirementEvidence,
} from "@/core/companies/judge-evidence";
import { db, withConnection } from "@/core/db/client";
import { evidence as evidenceTable } from "@/core/db/schema";
import type { Requirement } from "@/core/requirements";
import { roundDeps } from "@/workflows/find-companies-agent";
import type { FakeWorkflowStep } from "../support/step";
import { fakeWorkflowStep } from "../support/step";

const ROUND = 1;

function companyRow(domain: string): CompanyRow {
	return {
		name: `Co ${domain}`,
		domain,
		linkedinUrl: null,
		evidenceUrl: null,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: "a description of the company",
		signal: null,
		evidenceDate: null,
	};
}

function requirements(): Requirement[] {
	return [
		{
			id: "r_page",
			text: "the company runs the technology in production",
			kind: "hard",
			proof: "page",
			windowDays: null,
		},
		{
			id: "r_record",
			text: "the company sells to mid-market buyers",
			kind: "hard",
			proof: "record",
			windowDays: null,
		},
	];
}

function evidenceByRowFor(domain: string): EvidenceByRow {
	const perRow = new Map<string, RequirementEvidence>([
		[
			"r_page",
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
		step: harness.step,
		round: ROUND,
		today: "2026-09-01",
		seller: null,
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
	requirements: { id: string; quoteRequired: boolean }[];
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
			new Map([[`round_${ROUND}-judge`, { verdicts: [], costEntries: [] }]]),
		);
		const judge = judgeDepsFor(runId, harness);

		try {
			await judge(
				requirements(),
				[companyRow(domain)],
				testEnv,
				evidenceByRowFor(domain),
			);

			expect(harness.calls).toContain(`round_${ROUND}-judge-input`);
			const stored = await judgeInputRowsFor(runId);
			expect(stored).toHaveLength(1);
			const parsed = parseJudgeInput(stored[0]?.value);
			expect(parsed.round).toBe(ROUND);
			expect(parsed.domain).toBe(domain);
			expect(parsed.fields.name).toBe(`Co ${domain}`);
			expect(parsed.requirements).toEqual([
				{ id: "r_page", quoteRequired: true },
				{ id: "r_record", quoteRequired: false },
			]);
			expect(parsed.evidence?.r_page?.quote).toBe(
				`${domain} runs it in production.`,
			);
		} finally {
			await deleteEvidenceFor(runId);
		}
	});
});
