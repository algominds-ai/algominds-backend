import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";

export type AgentRunState<T> =
	| { status: "running" }
	| { status: "completed"; output: T };

export type AgentPollContext = {
	env: Env;
	step: WorkflowStep;
	name: string;
	id: string;
	intervalSeconds: number;
	maxAttempts: number;
};

/** Adds what a step reported spending into the caller's ledger. */
export function applyCostEntries(
	entries: readonly CostEntry[],
	ledger: CostLedger,
): void {
	for (const entry of entries)
		ledger.reported(entry.provider, entry.op, entry.dollars);
}

/**
 * Polls one Exa agent run to completion, each attempt in its own durable step
 * and each wait in a durable sleep, so a replay re-reads a cached poll rather
 * than paying for a second run. Reports what every attempt spent into
 * `ledger`. Throws once the attempts run out.
 */
export async function pollAgentRun<T>(
	ctx: AgentPollContext,
	ledger: CostLedger,
	fetchRun: (ledger: CostLedger) => Promise<AgentRunState<T>>,
): Promise<T> {
	for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
		const polled = await ctx.step.do(
			`${ctx.name}-poll-${attempt}`,
			config.stepConfig.paidCall,
			async () => {
				const pollLedger = new CostLedger();
				const run = await fetchRun(pollLedger);
				return { run, costEntries: pollLedger.toJSON().entries };
			},
		);
		applyCostEntries(polled.costEntries, ledger);
		if (polled.run.status === "completed") return polled.run.output;
		await ctx.step.sleep(
			`${ctx.name}-wait-${attempt}`,
			`${ctx.intervalSeconds} seconds`,
		);
	}
	throw new NonRetryableError(
		`Exa agent run ${ctx.id} did not complete after ${ctx.maxAttempts} polls`,
	);
}
