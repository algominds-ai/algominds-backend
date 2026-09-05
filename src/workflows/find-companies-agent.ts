import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { FindCompaniesDeps } from "@/core/companies";
import {
	buildAgentRunRequest,
	toExaSearchResult,
} from "@/core/companies/agent-search";
import { gate } from "@/core/companies/gate";
import { fetchHomepages } from "@/core/companies/homepages";
import { judge } from "@/core/companies/judge";
import { proveRows } from "@/core/companies/proof";
import { backfillRecords } from "@/core/companies/record";
import { CostLedger } from "@/core/cost";
import { recentDomains } from "@/core/db/queries";
import type { ExaAgentCompany } from "@/core/providers/exa/agent";
import { getAgentRun, startAgentRun } from "@/core/providers/exa/agent";
import type { ExaResult } from "@/core/providers/exa/search";
import { search } from "@/core/providers/exa/search";
import type { IcpDoc, IcpSeller, SearchPlan } from "@/core/synthesize";
import { synthesize } from "@/core/synthesize";
import { applyCostEntries, pollAgentRun } from "@/workflows/agent-poll";

const POLL_INTERVAL_SECONDS = config.companies.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.companies.exaAgentMaxPollAttempts;
const COMPANIES_PER_ANGLE = config.companies.companiesPerAngle;
const START_STAGGER_MS = config.companies.agentStartStaggerMs;
const POLL_BUDGET_PER_SECOND = config.companies.exaPollBudgetPerSecond;

/**
 * Seconds between polls for one angle of a fan-out carrying `anglesInFlight`
 * angles, scaled up so the whole fan-out spends at most
 * `exaPollBudgetPerSecond` poll requests a second. A single-angle round keeps
 * `exaAgentPollIntervalSeconds` unchanged.
 */
function scaledPollIntervalSeconds(anglesInFlight: number): number {
	return Math.max(
		POLL_INTERVAL_SECONDS,
		Math.ceil(anglesInFlight / POLL_BUDGET_PER_SECOND),
	);
}

export type AgentSearchInput = {
	step: WorkflowStep;
	round: number;
	today: string;
	seller: IcpSeller | null;
};

type AngleInput = {
	input: AgentSearchInput;
	plan: SearchPlan;
	slot: number;
	anglesInFlight: number;
	excludeDomains: readonly string[];
};

/**
 * Runs one angle as its own durable agent run: start, poll to completion, and
 * return the companies it found. Each angle owns its own step names so a
 * replay resumes the angle it was in rather than restarting the fan-out, and
 * every angle after the first waits its slot out so a round never crosses
 * Exa's ten-requests-a-second limit.
 */
async function runAngle(
	angle: AngleInput,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentCompany[]> {
	const { input, plan, slot, anglesInFlight, excludeDomains } = angle;
	const { step, round, today, seller } = input;
	const name = `round_${round}-angle_${slot}`;
	if (slot > 0) {
		await step.sleep(
			`${name}-stagger`,
			`${Math.ceil((slot * START_STAGGER_MS) / 1000)} seconds`,
		);
	}
	const { id } = await step.do(
		`${name}-start`,
		config.stepConfig.paidCall,
		() =>
			startAgentRun(
				buildAgentRunRequest({
					plan,
					count: COMPANIES_PER_ANGLE,
					today,
					seller,
					excludeDomains,
				}),
				env,
			),
	);
	return pollAgentRun(
		{
			env,
			step,
			name,
			id,
			intervalSeconds: scaledPollIntervalSeconds(anglesInFlight),
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
}

/**
 * Builds the fan-out dependency: one agent run per angle the planner wrote,
 * started `agentStartStaggerMs` apart so a round never crosses Exa's
 * ten-requests-a-second limit, and their companies merged into one result.
 */
export function agentFanout(
	input: AgentSearchInput,
): FindCompaniesDeps["agentRound"] {
	return async (plans, excludeDomains, env, ledger) => {
		const anglesInFlight = plans.length;
		const perAngle = await Promise.all(
			plans.map((plan, slot) =>
				runAngle(
					{ input, plan, slot, anglesInFlight, excludeDomains },
					env,
					ledger,
				),
			),
		);
		return toExaSearchResult(`round_${input.round}-fanout`, perAngle.flat());
	};
}

/** Wraps the record backfill in one durable step, so a replay reuses the records it already paid for. */
export function steppedBackfill(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["backfill"] {
	return async (domains, env, ledger) => {
		const cached = await step.do(
			`round_${round}-backfill`,
			config.stepConfig.paidCall,
			async () => {
				const stepLedger = new CostLedger();
				const filled = await backfillRecords(domains, env, stepLedger);
				return {
					filled: filled.map((entry) => ({
						domain: entry.domain,
						record: entry.record ? JSON.stringify(entry.record) : null,
					})),
					costEntries: stepLedger.toJSON().entries,
				};
			},
		);
		applyCostEntries(cached.costEntries, ledger);
		return cached.filled.map((entry) => ({
			domain: entry.domain,
			record: entry.record ? readExaResult(entry.record) : null,
		}));
	};
}

/** One serialized Exa result read back after a durable step, whose reply must be plain JSON. */
function readExaResult(raw: string): ExaResult | null {
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object") return null;
	const candidate: ExaResult = {
		id: null,
		url: "",
		title: "",
		summary: null,
		company: null,
		person: null,
		...parsed,
	};
	return candidate.url === "" ? null : candidate;
}

/** Wraps the proving pass in one durable step, so a replay reuses the pages it already paid for. */
export function steppedProve(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["prove"] {
	return async (rows, requirement, env, ledger) => {
		const cached = await step.do(
			`round_${round}-prove`,
			config.stepConfig.paidCall,
			async () => {
				const stepLedger = new CostLedger();
				const proven = await proveRows(rows, requirement, env, stepLedger);
				return { proven, costEntries: stepLedger.toJSON().entries };
			},
		);
		applyCostEntries(cached.costEntries, ledger);
		return cached.proven;
	};
}

/** Wraps the homepage fetch in one durable step, so a replay reuses the pages it already paid for. */
export function steppedHomepages(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["homepages"] {
	return async (domains, env, ledger) => {
		const cached = await step.do(
			`round_${round}-homepages`,
			config.stepConfig.paidCall,
			async () => {
				const stepLedger = new CostLedger();
				const pages = await fetchHomepages(domains, env, stepLedger);
				return { pages, costEntries: stepLedger.toJSON().entries };
			},
		);
		applyCostEntries(cached.costEntries, ledger);
		return cached.pages;
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
					route: result.route,
					plans: result.plans,
					costEntries: result.ledger.toJSON().entries,
				};
			},
		);
		const ledger = new CostLedger();
		applyCostEntries(cached.costEntries, ledger);
		return { route: cached.route, plans: cached.plans, ledger };
	};
}

/**
 * Wraps the recent-domains lookup in its own durable step, for the same
 * replay-safety reason as `agentSynthesize`.
 */
export function agentRecentDomains(
	step: WorkflowStep,
	round: number,
): (env: Env, organizationId: string, days: number) => Promise<string[]> {
	return (env, organizationId, days) =>
		step.do(
			`round_${round}-recent-domains`,
			config.stepConfig.databaseCall,
			() => recentDomains(env, organizationId, days),
		);
}

/** Wraps the judge in its own durable step, for the same replay-safety reason as `agentSynthesize`. */
function steppedJudge(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["judge"] {
	return async (requirements, rows, env, evidenceByRow) => {
		const cached = await step.do(
			`round_${round}-judge`,
			config.stepConfig.paidCall,
			async () => {
				const result = await judge(requirements, rows, env, evidenceByRow);
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

/** Builds every dependency one round runs on. The route is the planner's, so both the search path and the agent fan-out are wired here and the round picks between them. */
export type RoundDepsInput = {
	accumulatedDomains: ReadonlySet<string>;
	step: WorkflowStep;
	round: number;
	today: string;
	seller: IcpDoc["seller"];
};

export function roundDeps(input: RoundDepsInput): FindCompaniesDeps {
	const { accumulatedDomains, step, round, today } = input;
	const seller = input.seller ?? null;
	const lookupRecentDomains = agentRecentDomains(step, round);
	return {
		recentDomains: async (env, organizationId, days) => {
			const known = await lookupRecentDomains(env, organizationId, days);
			return [...known, ...accumulatedDomains];
		},
		synthesize: agentSynthesize(step, round),
		search: (_plan, req, env, ledger) => search(req, env, ledger),
		agentRound: agentFanout({ step, round, today, seller }),
		backfill: steppedBackfill(step, round),
		prove: steppedProve(step, round),
		homepages: steppedHomepages(step, round),
		gate,
		judge: steppedJudge(step, round),
	};
}
