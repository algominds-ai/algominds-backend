import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type { FindCompaniesDeps } from "@/core/companies";
import {
	buildAgentRunRequest,
	toExaSearchResult,
} from "@/core/company-agent-search";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";
import { recentDomains } from "@/core/db/queries";
import type { ExaAgentCompany } from "@/core/providers/exa/agent";
import { getAgentRun, startAgentRun } from "@/core/providers/exa/agent";
import { synthesize } from "@/core/synthesize";

const EFFORT = config.companies.exaAgentEffort;
const POLL_INTERVAL_SECONDS = config.companies.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.companies.exaAgentMaxPollAttempts;

function applyCostEntries(
	entries: readonly CostEntry[],
	ledger: CostLedger,
): void {
	for (const entry of entries)
		ledger.reported(entry.provider, entry.op, entry.dollars);
}

type PollContext = { env: Env; step: WorkflowStep; name: string };

async function pollUntilComplete(
	id: string,
	ctx: PollContext,
	ledger: CostLedger,
): Promise<ExaAgentCompany[]> {
	for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
		const polled = await ctx.step.do(
			`${ctx.name}-poll-${attempt}`,
			config.stepConfig.paidCall,
			async () => {
				const pollLedger = new CostLedger();
				const run = await getAgentRun(id, ctx.env, pollLedger);
				return { run, costEntries: pollLedger.toJSON().entries };
			},
		);
		applyCostEntries(polled.costEntries, ledger);
		if (polled.run.status === "completed") return polled.run.companies;
		await ctx.step.sleep(
			`${ctx.name}-wait-${attempt}`,
			`${POLL_INTERVAL_SECONDS} seconds`,
		);
	}
	throw new NonRetryableError(
		`Exa agent run ${id} did not complete after ${MAX_POLL_ATTEMPTS} polls`,
	);
}

/**
 * Builds the `search` dependency for one round when the configured company
 * source is Exa's agent API: starts a run asking for `remaining` companies,
 * then polls it to completion with durable sleeps the workflow owns.
 */
export function agentSearch(
	step: WorkflowStep,
	round: number,
	remaining: number,
): FindCompaniesDeps["search"] {
	return async (req, env, ledger) => {
		const name = `round_${round}-agent`;
		const { id } = await step.do(
			`${name}-start`,
			config.stepConfig.paidCall,
			() => startAgentRun(buildAgentRunRequest(req, remaining, EFFORT), env),
		);
		const companies = await pollUntilComplete(id, { env, step, name }, ledger);
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
