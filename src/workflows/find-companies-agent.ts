import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { FindCompaniesDeps } from "@/core/companies";
import {
	buildAgentRunRequest,
	toExaSearchResult,
} from "@/core/companies/agent-search";
import { CostLedger } from "@/core/cost";
import { recentDomains } from "@/core/db/queries";
import { getAgentRun, startAgentRun } from "@/core/providers/exa/agent";
import { synthesize } from "@/core/synthesize";
import { applyCostEntries, pollAgentRun } from "@/workflows/agent-poll";

const POLL_INTERVAL_SECONDS = config.companies.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.companies.exaAgentMaxPollAttempts;
const JUDGE_CANDIDATE_MULTIPLE = config.companies.judgeCandidateMultiple;
const RESULTS_PER_ROUND = config.companies.resultsPerRound;

/**
 * Builds the `search` dependency for one round when the configured company
 * source is Exa's agent API: starts a run asking for enough candidates to
 * survive the filter, the gate and the judge that follow,
 * then polls it to completion with durable sleeps the workflow owns.
 */
export type AgentSearchInput = {
	step: WorkflowStep;
	round: number;
	remaining: number;
	today: string;
};

export function agentSearch(
	input: AgentSearchInput,
): FindCompaniesDeps["search"] {
	const { step, round, remaining, today } = input;
	return async (plan, _req, env, ledger) => {
		const name = `round_${round}-agent`;
		const wanted = Math.min(
			remaining * JUDGE_CANDIDATE_MULTIPLE,
			RESULTS_PER_ROUND,
		);
		const { id } = await step.do(
			`${name}-start`,
			config.stepConfig.paidCall,
			() => startAgentRun(buildAgentRunRequest(plan, wanted, today), env),
		);
		const companies = await pollAgentRun(
			{
				env,
				step,
				name,
				id,
				intervalSeconds: POLL_INTERVAL_SECONDS,
				maxAttempts: MAX_POLL_ATTEMPTS,
			},
			ledger,
			async (pollLedger) => {
				const run = await getAgentRun(id, env, pollLedger);
				return run.status === "completed"
					? { status: "completed", output: run.companies }
					: run;
			},
		);
		return toExaSearchResult(id, companies);
	};
}

/**
 * Wraps `synthesize` in its own durable step so a replay triggered by a
 * later `step.sleep` in the same round returns the cached plan instead of
 * paying for a second, possibly different, model call.
 */
export function agentSynthesize(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["synthesize"] {
	return async (input, env) => {
		const cached = await step.do(
			`round_${round}-synthesize`,
			config.stepConfig.paidCall,
			async () => {
				const result = await synthesize(input, env);
				return {
					plan: result.plan,
					costEntries: result.ledger.toJSON().entries,
				};
			},
		);
		const ledger = new CostLedger();
		applyCostEntries(cached.costEntries, ledger);
		return { plan: cached.plan, ledger };
	};
}

/**
 * Wraps the recent-domains lookup in its own durable step, for the same
 * replay-safety reason as `agentSynthesize`.
 */
export function agentRecentDomains(
	step: WorkflowStep,
	round: number,
): (env: Env, icpId: string, days: number) => Promise<string[]> {
	return (env, icpId, days) =>
		step.do(
			`round_${round}-recent-domains`,
			config.stepConfig.databaseCall,
			() => recentDomains(env, icpId, days),
		);
}
