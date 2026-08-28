import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";
import type { FindPeopleDeps, TitlesResult } from "@/core/people";
import { decisionMakerTitles } from "@/core/people";
import type { PeopleCompany } from "@/core/person-candidates";
import type { ExaAgentPerson } from "@/core/providers/exa-agent";
import {
	buildPersonAgentRunRequest,
	getAgentPeopleRun,
	startAgentRun,
	toExaSearchResult,
} from "@/core/providers/exa-agent";
import type { IcpDoc } from "@/core/synthesize";

const EFFORT = config.people.exaAgentEffort;
const POLL_INTERVAL_SECONDS = config.people.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.people.exaAgentMaxPollAttempts;
const RESULTS_PER_COMPANY = config.people.resultsPerCompany;

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
): Promise<ExaAgentPerson[]> {
	for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
		const polled = await ctx.step.do(
			`${ctx.name}-poll-${attempt}`,
			config.stepConfig.paidCall,
			async () => {
				const pollLedger = new CostLedger();
				const run = await getAgentPeopleRun(id, ctx.env, pollLedger);
				return { run, costEntries: pollLedger.toJSON().entries };
			},
		);
		applyCostEntries(polled.costEntries, ledger);
		if (polled.run.status === "completed") return polled.run.people;
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
 * Builds the `search` dependency for one people batch when the configured
 * people source is Exa's agent API. Each company gets its own nested step
 * names. See `docs/solutions/agent-run-polling.md`.
 */
export function agentPersonSearch(
	step: WorkflowStep,
	batchIndex: number,
	companies: readonly PeopleCompany[],
): FindPeopleDeps["search"] {
	let callIndex = 0;
	return async (req, env, ledger) => {
		const index = callIndex;
		callIndex += 1;
		const company = companies[index];
		if (!company) {
			throw new NonRetryableError(
				`agentPersonSearch: no company at index ${index} for people-batch-${batchIndex}`,
			);
		}
		const name = `people-batch-${batchIndex}-company-${index}-agent`;
		const { id } = await step.do(
			`${name}-start`,
			config.stepConfig.paidCall,
			() =>
				startAgentRun(
					buildPersonAgentRunRequest(req, RESULTS_PER_COMPANY, EFFORT),
					env,
				),
		);
		const people = await pollUntilComplete(id, { env, step, name }, ledger);
		return toExaSearchResult(id, people, company.name);
	};
}

/**
 * Wraps `decisionMakerTitles` in its own durable step, so a replay returns
 * the cached titles instead of paying for a second model call.
 */
export function agentDecisionMakerTitles(
	step: WorkflowStep,
	batchIndex: number,
): FindPeopleDeps["decisionMakerTitles"] {
	return async (icp: IcpDoc, env: Env) => {
		const cached = await step.do(
			`people-batch-${batchIndex}-titles`,
			config.stepConfig.paidCall,
			async () => {
				const result = await decisionMakerTitles(icp, env);
				return {
					titles: result.titles,
					costEntries: result.ledger.toJSON().entries,
				};
			},
		);
		const ledger = new CostLedger();
		applyCostEntries(cached.costEntries, ledger);
		const output: TitlesResult = { titles: cached.titles, ledger };
		return output;
	};
}
