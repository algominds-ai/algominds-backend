import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type { FindPeopleDeps } from "@/core/people";
import type { PeopleCompany } from "@/core/person-candidates";
import {
	buildPersonAgentRunRequest,
	getAgentPeopleRun,
	startAgentRun,
	toExaSearchResult,
} from "@/core/providers/exa/agent";
import { pollAgentRun } from "@/workflows/agent-poll";

const EFFORT = config.people.exaAgentEffort;
const POLL_INTERVAL_SECONDS = config.people.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.people.exaAgentMaxPollAttempts;
const RESULTS_PER_COMPANY = config.people.resultsPerCompany;

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
		const name = `people-batch-${batchIndex}-${company.domain}-agent`;
		const { id } = await step.do(
			`${name}-start`,
			config.stepConfig.paidCall,
			() =>
				startAgentRun(
					buildPersonAgentRunRequest(req, RESULTS_PER_COMPANY, EFFORT),
					env,
				),
		);
		const people = await pollAgentRun(
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
				const run = await getAgentPeopleRun(id, env, pollLedger);
				return run.status === "completed"
					? { status: "completed", output: run.people }
					: run;
			},
		);
		return toExaSearchResult(id, people, company.name);
	};
}
