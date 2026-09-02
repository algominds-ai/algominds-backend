import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CostLedger } from "../src/core/cost";
import type { AgentRunState } from "../src/workflows/agent-poll";
import { pollAgentRun } from "../src/workflows/agent-poll";

function fakeWorkflowStep(): { step: WorkflowStep; sleeps: string[] } {
	const sleeps: string[] = [];
	const step: WorkflowStep = {
		do: async (
			name: string,
			second: unknown,
			third?: unknown,
		): Promise<unknown> => {
			const callback = typeof second === "function" ? second : third;
			if (typeof callback !== "function") {
				throw new Error(`fake step: no callback for ${name}`);
			}
			const ctx: WorkflowStepContext = {
				step: { name, count: 0 },
				attempt: 1,
				config: {},
			};
			return callback(ctx);
		},
		sleep: async (_name: string, duration: string | number) => {
			sleeps.push(String(duration));
		},
		sleepUntil: async () => undefined,
		waitForEvent: async () => {
			throw new Error("fake step: waitForEvent not implemented");
		},
	};
	return { step, sleeps };
}

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
