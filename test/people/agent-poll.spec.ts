import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import type { AgentRunState } from "@/workflows/agent-poll";
import { pollAgentRun } from "@/workflows/agent-poll";
import { fakeWorkflowStep } from "../support/step";

describe("pollAgentRun: a run that never completes", () => {
	it("throws after the configured attempts, polling exactly that many times and never again", async () => {
		let calls = 0;
		const { step, sleeps } = fakeWorkflowStep();
		const ledger = new CostLedger();
		const maxAttempts = 3;

		const fetchRun = async (): Promise<AgentRunState<{ done: true }>> => {
			calls += 1;
			return { status: "running" };
		};

		await expect(
			pollAgentRun(
				{
					env: testEnv,
					step,
					name: "poll-probe",
					id: "run-x",
					intervalSeconds: 1,
					maxAttempts,
				},
				ledger,
				fetchRun,
			),
		).rejects.toThrow(
			`Exa agent run run-x did not complete after ${maxAttempts} polls`,
		);

		expect(calls).toBe(maxAttempts);
		expect(sleeps).toHaveLength(maxAttempts);
	});
});

describe("pollAgentRun: a run that completes before the limit", () => {
	it("stops polling the moment a run completes, banking every attempt's reported cost", async () => {
		const { step } = fakeWorkflowStep();
		const ledger = new CostLedger();
		let calls = 0;

		const fetchRun = async (
			pollLedger: CostLedger,
		): Promise<AgentRunState<{ id: string }>> => {
			calls += 1;
			pollLedger.reported("exa", "agent-poll", 0.01);
			if (calls === 2) return { status: "completed", output: { id: "done" } };
			return { status: "running" };
		};

		const output = await pollAgentRun(
			{
				env: testEnv,
				step,
				name: "poll-probe",
				id: "run-y",
				intervalSeconds: 1,
				maxAttempts: 5,
			},
			ledger,
			fetchRun,
		);

		expect(output).toEqual({ id: "done" });
		expect(calls).toBe(2);
		expect(ledger.total()).toBeCloseTo(0.02, 10);
	});
});
