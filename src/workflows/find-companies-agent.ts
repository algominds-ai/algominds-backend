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
import {
	agentRunEvidenceRow,
	agentRunSettleEvidenceRow,
} from "@/core/companies/rows";
import { addPartialSpend, CostLedger, purchase } from "@/core/cost";
import { appendEvidence, recentDomains } from "@/core/db/queries";
import type { ExaAgentCompany } from "@/core/providers/exa/agent";
import {
	cancelAgentRun,
	getAgentRun,
	startAgentRun,
} from "@/core/providers/exa/agent";
import type { ExaResult } from "@/core/providers/exa/search";
import { search } from "@/core/providers/exa/search";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import { synthesize } from "@/core/synthesize";
import { applyCostEntries, pollAgentRun } from "@/workflows/agent-poll";
import { durablePurchase } from "@/workflows/durable-purchase";
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
	const angleLedger = new CostLedger();
	try {
		const output = await pollAgentRun(
			{
				env,
				step,
				name,
				id,
				intervalSeconds: scaledPollIntervalSeconds(anglesInFlight),
				maxAttempts: MAX_POLL_ATTEMPTS,
			},
			angleLedger,
			async (pollLedger) => {
				const run = await getAgentRun(id, env, pollLedger);
				return run.status === "completed"
					? { status: "completed", output: run.companies }
					: run;
			},
		);
		applyCostEntries(angleLedger.toJSON().entries, ledger);
		return output;
	} catch (error) {
		applyCostEntries(angleLedger.toJSON().entries, ledger);
		await settleAgentRun(
			{ step, name, id, runId, env },
			ledger,
			angleLedger.total(),
		).catch(() => undefined);
		throw error;
	}
}

type SettleInput = {
	step: WorkflowStep;
	name: string;
	id: string;
	runId: string;
	env: Env;
};

/**
 * Cancels a paid Exa agent run its failed poll left behind, re-reading the
 * settlement up to three times so the run's final charge lands in `ledger`
 * rather than disappearing with it. Records an `agent-run-settle` evidence
 * row either way, with `billingUnknown` when no terminal cost could be read.
 */
async function settleAgentRun(
	input: SettleInput,
	ledger: CostLedger,
	billed: number,
): Promise<void> {
	const { step, name, id, runId, env } = input;
	let settled: { status: string; costDollars: number | null } | null = null;
	let resolved = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		const result = await step.do(
			`${name}-settle-${attempt}`,
			config.stepConfig.paidCall,
			() =>
				purchase(async () => ({
					value: await cancelAgentRun(id, env, attempt === 0),
					costDollars: 0,
				})),
		);
		settled = result.value ?? settled;
		const cost = result.value?.costDollars;
		if (cost !== null && cost !== undefined && cost > billed) {
			ledger.reported("exa", "agent", cost - billed);
			billed = cost;
		}
		if (result.value?.terminal && result.value.costDollars !== null) {
			resolved = true;
			break;
		}
		if (attempt < 2)
			await step.sleep(`${name}-settle-wait-${attempt}`, "5 seconds");
	}
	await step.do(`${name}-settle-evidence`, config.stepConfig.databaseCall, () =>
		appendEvidence(env, [
			agentRunSettleEvidenceRow(runId, {
				id,
				status: settled?.status ?? null,
				costDollars: settled?.costDollars ?? null,
				billingUnknown: !resolved,
			}),
		]),
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
		const settled = await durablePurchase(
			{
				step,
				name: `round_${round}-backfill`,
				budget: "paidCall",
				ledger,
			},
			async (stepLedger) => {
				const filled = await backfillRecords(domains, env, stepLedger);
				return {
					filled: filled.map((entry) => ({
						domain: entry.domain,
						record: entry.record ? JSON.stringify(entry.record) : null,
					})),
				};
			},
		);
		return settled.filled.map((entry) => ({
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
		const settled = await durablePurchase(
			{
				step,
				name: `round_${round}-evidence`,
				budget: "paidCall",
				ledger,
			},
			async (stepLedger) => {
				const result = await retrieveCompanyEvidence(input, env, stepLedger);
				return {
					evidenceByRow: [...result.evidenceByRow.entries()].map(
						([index, evidence]) => [index, [...evidence.entries()]] as const,
					),
					pages: result.pages,
				};
			},
		);
		return {
			evidenceByRow: new Map(
				settled.evidenceByRow.map(([index, evidence]) => [
					index,
					new Map<string, RequirementEvidence>(evidence),
				]),
			),
			pages: settled.pages,
		};
	};
}
export function agentSynthesize(
	step: WorkflowStep,
	round: number,
): FindCompaniesDeps["synthesize"] {
	return async (input, env) => {
		const ledger = new CostLedger();
		try {
			const settled = await durablePurchase(
				{
					step,
					name: `round_${round}-synthesize`,
					budget: "paidCall",
					ledger,
				},
				async (stepLedger) => {
					const result = await synthesize(input, env, stepLedger);
					return { route: result.route, plans: result.plans };
				},
			);
			return { route: settled.route, plans: settled.plans, ledger };
		} catch (error) {
			throw addPartialSpend(error, ledger.total());
		}
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
