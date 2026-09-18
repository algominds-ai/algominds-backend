import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import { db, withConnection } from "@/core/db/client";
import { evidence as evidenceTable } from "@/core/db/schema";
import type { SearchPlan } from "@/core/synthesize";
import { agentFanout } from "@/workflows/find-companies-agent";
import { fakeSecretEnv } from "../support/env";
import { fakeExaAgentRun } from "../support/fetch";
import { profileFixture } from "../support/icp";
import { fakeWorkflowStep } from "../support/step";

function plan(): SearchPlan {
	return {
		query: "angle one",
		angle: "angle-1",
		source: "exa-search",
		agentEffort: "low",
		userLocation: null,
		countries: [],
		minWorkforce: null,
		maxWorkforce: null,
		minFoundedYear: null,
		maxFoundedYear: null,
		minRevenueAnnual: null,
		maxRevenueAnnual: null,
		minFundingTotal: null,
		maxFundingTotal: null,
	};
}

async function evidenceRowsFor(subjectId: string) {
	return withConnection(testEnv, "direct", db, (connection) =>
		connection
			.select()
			.from(evidenceTable)
			.where(eq(evidenceTable.subjectId, subjectId)),
	);
}

async function deleteEvidenceFor(subjectId: string): Promise<void> {
	await withConnection(testEnv, "direct", db, (connection) =>
		connection
			.delete(evidenceTable)
			.where(eq(evidenceTable.subjectId, subjectId)),
	);
}

describe("an angle banks the agent run it started before it can fail", () => {
	it("leaves the started run's id in evidence even when the poll step then throws", async () => {
		const runId = `agent-run-started-test-${crypto.randomUUID()}`;
		globalThis.fetch = fakeExaAgentRun({ structured: { companies: [] } }).fetch;
		const failing = fakeWorkflowStep(
			new Map([["round_1-angle_0-poll-1", new Error("the poll step failed")]]),
		);
		const fanout = agentFanout({
			step: failing.step,
			round: 1,
			remaining: 15,
			today: "2026-08-30",
			icp: profileFixture(),
			runId,
		});

		await expect(
			fanout(
				[plan()],
				[],
				fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
				new CostLedger(),
			),
		).rejects.toThrow("the poll step failed");

		const rows = await evidenceRowsFor(runId);
		const agentRunRows = rows.filter((row) => row.kind === "agent-run");
		expect(agentRunRows).toHaveLength(1);
		expect(JSON.parse(agentRunRows[0]?.value ?? "{}")).toMatchObject({
			id: "run-0",
			angle: "angle-1",
			effort: "low",
		});

		await deleteEvidenceFor(runId);
	});

	it("settles the started run even when recording its start fails", async () => {
		const runId = `agent-start-evidence-test-${crypto.randomUUID()}`;
		globalThis.fetch = fakeExaAgentRun({ structured: { companies: [] } }).fetch;
		const failing = fakeWorkflowStep(
			new Map([
				[
					"round_1-angle_0-start-evidence",
					new Error("the start evidence write failed"),
				],
			]),
		);
		const fanout = agentFanout({
			step: failing.step,
			round: 1,
			remaining: 15,
			today: "2026-08-30",
			icp: profileFixture(),
			runId,
		});

		await expect(
			fanout(
				[plan()],
				[],
				fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
				new CostLedger(),
			),
		).rejects.toThrow("the start evidence write failed");

		const rows = await evidenceRowsFor(runId);
		const settleRows = rows.filter((row) => row.kind === "agent-run-settle");
		expect(settleRows).toHaveLength(1);
		expect(JSON.parse(settleRows[0]?.value ?? "{}")).toMatchObject({
			id: "run-0",
		});

		await deleteEvidenceFor(runId);
	});
});
