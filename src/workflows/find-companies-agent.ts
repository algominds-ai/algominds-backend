import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { FindCompaniesDeps } from "@/core/companies";
import {
	buildAgentRunRequest,
	toExaSearchResult,
} from "@/core/companies/agent-search";
import { gate } from "@/core/companies/gate";
import { judge } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import { recentDomains } from "@/core/db/queries";
import { getAgentRun, startAgentRun } from "@/core/providers/exa/agent";
import { search } from "@/core/providers/exa/search";
import type { IcpDoc, IcpSeller } from "@/core/synthesize";
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
	seller: IcpSeller | null;
};

export function agentSearch(
	input: AgentSearchInput,
): FindCompaniesDeps["search"] {
	const { step, round, remaining, today, seller } = input;
	return async (plan, _req, env, ledger) => {
		const name = `round_${round}-agent`;
		const wanted = Math.min(
			remaining * JUDGE_CANDIDATE_MULTIPLE,
			RESULTS_PER_ROUND,
		);
		const { id } = await step.do(
			`${name}-start`,
			config.stepConfig.paidCall,
			() =>
				startAgentRun(buildAgentRunRequest(plan, wanted, today, seller), env),
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

/**
 * Wraps the plain Exa search in its own durable step, so a later failure in
 * the same round replays the results it already paid for instead of buying
 * them again.
 */
/** Wraps the judge in its own durable step, for the same replay-safety reason as `agentSynthesize`. */
function steppedJudge(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["judge"] {
	return async (icp, rows, env, recency) => {
		const cached = await step.do(
			`round_${round}-judge`,
			config.stepConfig.paidCall,
			async () => {
				const result = await judge(icp, rows, env, recency);
				return {
					verdicts: result.verdicts,
					costEntries: result.ledger.toJSON().entries,
				};
			},
		);
		const ledger = new CostLedger();
		applyCostEntries(cached.costEntries, ledger);
		return { verdicts: cached.verdicts, ledger };
	};
}

/** Builds every dependency one round runs on, sending the round to the agent when its plan chose one and to a single Exa search when it did not. */
export type RoundDepsInput = {
	accumulatedDomains: ReadonlySet<string>;
	step: WorkflowStep;
	round: number;
	remaining: number;
	today: string;
	seller: IcpDoc["seller"];
};

export function roundDeps(input: RoundDepsInput): FindCompaniesDeps {
	const { accumulatedDomains, step, round, remaining, today } = input;
	const seller = input.seller ?? null;
	const lookupRecentDomains = agentRecentDomains(step, round);
	const viaAgent = agentSearch({ step, round, remaining, today, seller });
	return {
		recentDomains: async (env, icpId, days) => {
			const known = await lookupRecentDomains(env, icpId, days);
			return [...known, ...accumulatedDomains];
		},
		synthesize: agentSynthesize(step, round),
		search: (plan, req, env, ledger) =>
			plan.source === "exa-agent"
				? viaAgent(plan, req, env, ledger)
				: search(req, env, ledger),
		gate,
		judge: steppedJudge(step, round),
	};
}
