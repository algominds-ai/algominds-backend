import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { FindCompaniesDeps } from "@/core/companies";
import {
	buildAgentRunRequest,
	toExaSearchResult,
} from "@/core/companies/agent-search";
import { gate } from "@/core/companies/gate";
import type { RequirementEvidence } from "@/core/companies/judge-evidence";
import { retrieveCompanyEvidence } from "@/core/companies/proof";
import { backfillRecords } from "@/core/companies/record";
import type { RoundTiming } from "@/core/companies/rows";
import { agentRunEvidenceRow } from "@/core/companies/rows";
import { addPartialSpend, CostLedger } from "@/core/cost";
import { appendEvidence, recentDomains } from "@/core/db/queries";
import type { ExaAgentCompany } from "@/core/providers/exa/agent";
import { getAgentRun, startAgentRun } from "@/core/providers/exa/agent";
import type { ExaResult } from "@/core/providers/exa/search";
import { search } from "@/core/providers/exa/search";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import { synthesize } from "@/core/synthesize";
import { applyCostEntries, pollAgentRun } from "@/workflows/agent-poll";
import { steppedJudge } from "@/workflows/find-companies-judge";

const POLL_INTERVAL_SECONDS = config.companies.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.companies.exaAgentMaxPollAttempts;
const START_STAGGER_MS = config.companies.agentStartStaggerMs;
const POLL_BUDGET_PER_SECOND = config.companies.exaPollBudgetPerSecond;
function scaledPollIntervalSeconds(anglesInFlight: number): number {
	return Math.max(
		POLL_INTERVAL_SECONDS,
		Math.ceil(anglesInFlight / POLL_BUDGET_PER_SECOND),
	);
}
export type AgentSearchInput = {
	remaining: number;
	step: WorkflowStep;
	round: number;
	today: string;
	icp: IcpDoc;
	runId: string;
};
type AngleInput = {
	input: AgentSearchInput;
	plan: SearchPlan;
	slot: number;
	anglesInFlight: number;
	excludeDomains: readonly string[];
};
async function runAngle(
	angle: AngleInput,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentCompany[]> {
	const { input, plan, slot, anglesInFlight, excludeDomains } = angle;
	const { step, round, today, icp, runId } = input;
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
					count: Math.ceil(input.remaining / anglesInFlight),
					today,
					icp,
					excludeDomains,
				}),
				env,
			),
	);
	await step.do(`${name}-start-evidence`, config.stepConfig.databaseCall, () =>
		appendEvidence(env, [
			agentRunEvidenceRow(runId, {
				id,
				angle: plan.angle,
				effort: plan.agentEffort,
			}),
		]),
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
export function agentFanout(
	input: AgentSearchInput,
): FindCompaniesDeps["agentRound"] {
	return async (plans, excludeDomains, env, ledger) => {
		const anglesInFlight = plans.length;
		const outcomes = await Promise.allSettled(
			plans.map((plan, slot) =>
				runAngle(
					{ input, plan, slot, anglesInFlight, excludeDomains },
					env,
					ledger,
				),
			),
		);
		const failure = outcomes.find(
			(outcome): outcome is PromiseRejectedResult =>
				outcome.status === "rejected",
		);
		if (failure) throw failure.reason;
		return toExaSearchResult(
			`round_${input.round}-fanout`,
			outcomes.flatMap((outcome) =>
				outcome.status === "fulfilled" ? outcome.value : [],
			),
		);
	};
}
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
export function steppedEvidence(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["retrieveEvidence"] {
	return async (input, env, ledger) => {
		const cached = await step.do(
			`round_${round}-evidence`,
			config.stepConfig.paidCall,
			async () => {
				const stepLedger = new CostLedger();
				try {
					const result = await retrieveCompanyEvidence(input, env, stepLedger);
					return {
						evidenceByRow: [...result.evidenceByRow.entries()].map(
							([index, evidence]) => [index, [...evidence.entries()]] as const,
						),
						pages: result.pages,
						costEntries: stepLedger.toJSON().entries,
					};
				} catch (error) {
					throw addPartialSpend(error, stepLedger.total());
				}
			},
		);
		applyCostEntries(cached.costEntries, ledger);
		return {
			evidenceByRow: new Map(
				cached.evidenceByRow.map(([index, evidence]) => [
					index,
					new Map<string, RequirementEvidence>(evidence),
				]),
			),
			pages: cached.pages,
		};
	};
}
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
export function agentRecentDomains(
	step: WorkflowStep,
	round: number,
): (env: Env, organizationId: string) => Promise<string[]> {
	return (env, organizationId) =>
		step.do(
			`round_${round}-recent-domains`,
			config.stepConfig.databaseCall,
			() => recentDomains(env, organizationId),
		);
}
export type RoundDepsInput = {
	remaining: number;
	accumulatedDomains: ReadonlySet<string>;
	step: WorkflowStep;
	round: number;
	today: string;
	icp: IcpDoc;
	timings: RoundTiming[];
	runId: string;
};
function timed<A extends unknown[], R>(
	dep: string,
	fn: (...args: A) => Promise<R>,
	timings: RoundTiming[],
): (...args: A) => Promise<R> {
	return async (...args) => {
		const started = Date.now();
		try {
			return await fn(...args);
		} finally {
			timings.push({ dep, seconds: (Date.now() - started) / 1000 });
		}
	};
}
export function timedDeps(
	deps: FindCompaniesDeps,
	timings: RoundTiming[],
): FindCompaniesDeps {
	return {
		...deps,
		synthesize: timed("synthesize", deps.synthesize, timings),
		search: timed("search", deps.search, timings),
		agentRound: timed("agent", deps.agentRound, timings),
		backfill: timed("backfill", deps.backfill, timings),
		retrieveEvidence: timed("evidence", deps.retrieveEvidence, timings),
		judge: timed("judge", deps.judge, timings),
	};
}
export function roundDeps(input: RoundDepsInput): FindCompaniesDeps {
	const { accumulatedDomains, step, round, today, runId } = input;
	const icp = input.icp;
	const lookupRecentDomains = agentRecentDomains(step, round);
	const deps: FindCompaniesDeps = {
		recentDomains: async (env, organizationId) => {
			const known = await lookupRecentDomains(env, organizationId);
			return [...known, ...accumulatedDomains];
		},
		synthesize: agentSynthesize(step, round),
		search: (_plan, req, env, ledger) => search(req, env, ledger),
		agentRound: agentFanout({
			step,
			round,
			today,
			icp,
			remaining: input.remaining,
			runId: input.runId,
		}),
		backfill: steppedBackfill(step, round),
		retrieveEvidence: steppedEvidence(step, round),
		gate,
		judge: steppedJudge(step, round, runId),
	};
	return timedDeps(deps, input.timings);
}
