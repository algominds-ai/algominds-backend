import { config } from "@/config";
import type {
	CompanyCapture,
	FindCompaniesReject,
	RetrievedPage,
} from "@/core/companies/candidates";
import {
	collectDomains,
	groupRejectReasons,
} from "@/core/companies/candidates";

import { toGateRejects } from "@/core/companies/evidence";
import type {
	CompanyRow,
	GateOptions,
	GateResult,
	SearchResult,
} from "@/core/companies/gate";
import type { JudgeResult } from "@/core/companies/judge";
import type { ProvenRow } from "@/core/companies/proving";
import type { BackfilledRecord } from "@/core/companies/record";
import type { RoundOutcome } from "@/core/companies/round";
import { runRound } from "@/core/companies/round";
import { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type {
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import { hardPageRequirements } from "@/core/requirements";
import type {
	IcpDoc,
	SearchPlan,
	SynthesizeInput,
	SynthesizeResult,
} from "@/core/synthesize";

export type { FindCompaniesReject, RetrievedPage };

const SPEND_PER_RUN = config.spend.perRunDollars;

const {
	maxRounds: MAX_ROUNDS,
	seenDomainsWindowDays: SEEN_DOMAINS_WINDOW_DAYS,
	maxAnglesPerRound: MAX_ANGLES_PER_ROUND,
} = config.companies;

export type FindCompaniesOptions = {
	icpId: string;
	organizationId: string;
	env: Env;
	today: string;
	requirements: readonly Requirement[];
	maxRounds?: number;
	pastAngles?: readonly string[];
	feedback?: readonly string[];
	excludeDomains?: readonly string[];
};

export type FindCompaniesDeps = {
	recentDomains: (
		env: Env,
		organizationId: string,
		days: number,
	) => Promise<string[]>;
	synthesize: (input: SynthesizeInput, env: Env) => Promise<SynthesizeResult>;
	search: (
		plan: SearchPlan,
		req: ExaSearchRequest,
		env: Env,
		ledger: CostLedger,
	) => Promise<ExaSearchResult>;
	agentRound: (
		plans: readonly SearchPlan[],
		excludeDomains: readonly string[],
		env: Env,
		ledger: CostLedger,
	) => Promise<ExaSearchResult>;
	backfill: (
		domains: readonly string[],
		env: Env,
		ledger: CostLedger,
	) => Promise<BackfilledRecord[]>;
	prove: (
		rows: readonly CompanyRow[],
		requirement: Requirement,
		env: Env,
		ledger: CostLedger,
	) => Promise<ProvenRow[]>;
	gate: (
		rows: readonly CompanyRow[],
		results: readonly SearchResult[],
		opts: GateOptions,
	) => GateResult;
	judge: (
		requirements: readonly Requirement[],
		rows: readonly CompanyRow[],
		env: Env,
	) => Promise<JudgeResult>;
};

export type FindCompaniesStatus =
	| "complete"
	| "short"
	| "exhausted"
	| "empty"
	| "capped";

export type FindCompaniesResult = {
	companies: CompanyRow[];
	requested: number;
	found: number;
	rounds: number;
	status: FindCompaniesStatus;
	costDollars: number;
	rejects: FindCompaniesReject[];
	searches: SearchPlan[];
	captures: Record<string, CompanyCapture>;
	seenDomains: string[];
	feedback: string[];
	pages: RetrievedPage[];
};

/** Dollars already banked by earlier rounds. Cost is only known after a call returns, so this can stop the next round but never the one in flight. */
function spentSoFar(ledgers: readonly CostLedger[]): number {
	return CostLedger.merge(...ledgers).total();
}

/**
 * How many angles one round asks the planner for: one for a search round,
 * because one company search returns a hundred records, and two per company
 * still wanted for an agent round, because an agent run stops as soon as its
 * schema is satisfied and returns few companies whatever it is asked for.
 */
export function anglesForRound(
	requirements: readonly Requirement[],
	shortfall: number,
): number {
	if (hardPageRequirements(requirements).length === 0) return 1;
	return Math.max(1, Math.min(MAX_ANGLES_PER_ROUND, shortfall * 2));
}

type RunInput = {
	icp: IcpDoc;
	requirements: readonly Requirement[];
	count: number;
	excluded: Set<string>;
};

type RoundsAccumulator = {
	companies: CompanyRow[];
	rejects: FindCompaniesReject[];
	ledgers: CostLedger[];
	rounds: number;
	emptyRounds: number;
	status: FindCompaniesStatus;
	searches: SearchPlan[];
	captures: Record<string, CompanyCapture>;
	feedback: string[];
	pages: RetrievedPage[];
	provenRate: string | null;
	pastAngles: string[];
};

const EMPTY_ROUND_FEEDBACK =
	"the previous query matched no companies at all, so it was too narrow: write a broader angle";

/** Records one round's domains as seen and returns the rejects it produced, in the order the stages ran. */
function absorbRound(
	outcome: RoundOutcome,
	seenDomains: Set<string>,
): FindCompaniesReject[] {
	for (const domain of collectDomains(outcome.rows)) seenDomains.add(domain);
	return [
		...outcome.filterRejects,
		...toGateRejects(outcome.rows, outcome.gateRejects),
		...outcome.evidenceRejects,
		...outcome.judgeRejects,
	];
}

type RoundDecision = "complete" | "retry" | "exhausted" | "continue";

/**
 * What a finished round means for the loop. `retry` says the round is worth
 * repeating: either the vendor matched nothing at all, or it matched rows
 * that the filter refused outright, so no company ever reached the seen-domain
 * check. `exhausted` means the opposite: rows survived the filter, but every
 * one of them was a domain this run had already seen.
 */
export function decideRound(
	found: number,
	wanted: number,
	outcome: { resultCount: number; filteredCount: number; unseenCount: number },
): RoundDecision {
	if (found >= wanted) return "complete";
	if (outcome.resultCount === 0) return "retry";
	if (outcome.filteredCount === 0) return "retry";
	if (outcome.unseenCount === 0) return "exhausted";
	return "continue";
}

/** `empty` only when every round the run paid for matched nothing at all. */
export function terminalStatus(
	status: FindCompaniesStatus,
	found: number,
	emptyRounds: number,
	rounds: number,
): FindCompaniesStatus {
	if (found > 0 || rounds === 0) return status;
	return emptyRounds === rounds ? "empty" : status;
}

function emptyAccumulator(opts: FindCompaniesOptions): RoundsAccumulator {
	return {
		companies: [],
		rejects: [],
		ledgers: [],
		rounds: 0,
		emptyRounds: 0,
		status: "short",
		searches: [],
		captures: {},
		feedback: [...(opts.feedback ?? [])],
		pages: [],
		provenRate: null,
		pastAngles: [...(opts.pastAngles ?? [])],
	};
}

/** Folds one finished round into the accumulator, leaving only the loop's own stop decision to the caller. */
function absorbInto(
	acc: RoundsAccumulator,
	outcome: RoundOutcome,
	seenDomains: Set<string>,
): void {
	acc.ledgers.push(outcome.ledger);
	acc.searches.push(...outcome.plans);
	for (const plan of outcome.plans) acc.pastAngles.push(plan.angle);
	Object.assign(acc.captures, outcome.captures);
	acc.pages.push(...outcome.pages);
	acc.provenRate = outcome.provenRate;
	const rejects = absorbRound(outcome, seenDomains);
	acc.rejects.push(...rejects);
	acc.companies.push(...outcome.accepted);
	acc.feedback = groupRejectReasons(rejects);
	if (outcome.resultCount === 0) {
		acc.emptyRounds += 1;
		acc.feedback = [...acc.feedback, EMPTY_ROUND_FEEDBACK];
	}
}

async function runRounds(
	input: RunInput,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<RoundsAccumulator> {
	const acc = emptyAccumulator(opts);
	const maxRounds = opts.maxRounds ?? MAX_ROUNDS;

	for (let round = 0; round < maxRounds; round++) {
		if (spentSoFar(acc.ledgers) >= SPEND_PER_RUN) {
			acc.status = "capped";
			break;
		}
		acc.rounds += 1;
		const outcome = await runRound(
			{
				icp: input.icp,
				requirements: input.requirements,
				count: Math.max(input.count - acc.companies.length, 1),
				pastAngles: [...acc.pastAngles],
				feedback: [...acc.feedback],
				provenRate: acc.provenRate,
				excluded: input.excluded,
			},
			opts,
			deps,
		);
		absorbInto(acc, outcome, input.excluded);
		const decision = decideRound(acc.companies.length, input.count, {
			resultCount: outcome.resultCount,
			filteredCount: outcome.rows.length,
			unseenCount: outcome.unseenCount,
		});
		if (decision === "retry") continue;
		if (decision !== "continue") {
			acc.status = decision;
			break;
		}
	}
	return acc;
}

/**
 * Runs the deterministic company-discovery loop: read seen domains, then
 * plan, gather, gate, prove, judge and decide one round at a time until
 * `count` is met, `maxRounds` pass, or a round adds no unseen domain. The
 * requirements always outrank the count; a refused row never reaches the
 * result.
 */
export async function findCompanies(
	icp: IcpDoc,
	count: number,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<FindCompaniesResult> {
	const requirements = opts.requirements;
	const known = await deps.recentDomains(
		opts.env,
		opts.organizationId,
		SEEN_DOMAINS_WINDOW_DAYS,
	);
	const excluded = new Set([
		...known.map(normalizeDomain),
		...(opts.excludeDomains ?? []).map(normalizeDomain),
	]);
	const outcome = await runRounds(
		{ icp, requirements, count, excluded },
		opts,
		deps,
	);
	const companies = outcome.companies.slice(0, count);
	return {
		companies,
		requested: count,
		found: companies.length,
		rounds: outcome.rounds,
		status: terminalStatus(
			outcome.status,
			companies.length,
			outcome.emptyRounds,
			outcome.rounds,
		),
		costDollars: CostLedger.merge(...outcome.ledgers).total(),
		rejects: outcome.rejects,
		searches: outcome.searches,
		captures: outcome.captures,
		seenDomains: [...excluded],
		feedback: outcome.feedback,
		pages: outcome.pages,
	};
}
