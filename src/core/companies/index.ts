import { config } from "@/config";
import type {
	CompanyCapture,
	FindCompaniesReject,
} from "@/core/companies/candidates";
import {
	buildSearchRequest,
	collectDomains,
	countUnseen,
	excludedDomains,
	filterEntities,
	groupRejectReasons,
} from "@/core/companies/candidates";
import type {
	CompanyRow,
	GateOptions,
	GateResult,
	Reject,
	SearchResult,
} from "@/core/companies/gate";
import type { JudgeResult, Verdict } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type {
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa/search";
import type {
	IcpDoc,
	SearchPlan,
	SynthesizeInput,
	SynthesizeResult,
} from "@/core/synthesize";

export type { FindCompaniesReject };

const SPEND_PER_RUN = config.spend.perRunDollars;

const {
	maxRounds: MAX_ROUNDS,
	judgeCandidateMultiple: JUDGE_CANDIDATE_MULTIPLE,
	seenDomainsWindowDays: SEEN_DOMAINS_WINDOW_DAYS,
} = config.companies;

export type FindCompaniesOptions = {
	icpId: string;
	env: Env;
	today: string;
	freshnessDays?: number;
	scoreFloor?: number;
	maxRounds?: number;
	pastAngles?: readonly string[];
	feedback?: readonly string[];
	excludeDomains?: readonly string[];
};

export type FindCompaniesDeps = {
	recentDomains: (env: Env, icpId: string, days: number) => Promise<string[]>;
	synthesize: (input: SynthesizeInput, env: Env) => Promise<SynthesizeResult>;
	search: (
		plan: SearchPlan,
		req: ExaSearchRequest,
		env: Env,
		ledger: CostLedger,
	) => Promise<ExaSearchResult>;
	gate: (
		rows: readonly CompanyRow[],
		results: readonly SearchResult[],
		opts: GateOptions,
	) => GateResult;
	judge: (
		icp: IcpDoc,
		rows: readonly CompanyRow[],
		env: Env,
		recency: string | null,
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
};

function toGateRejects(
	rows: readonly CompanyRow[],
	rejects: readonly Reject[],
): FindCompaniesReject[] {
	return rejects.map((reject) => ({
		domain: rows[reject.index]?.domain ?? null,
		reason: reject.reason,
		stage: "gate",
	}));
}

function applyVerdicts(
	keptRows: readonly CompanyRow[],
	verdicts: readonly Verdict[],
): { accepted: CompanyRow[]; judgeRejects: FindCompaniesReject[] } {
	const accepted: CompanyRow[] = [];
	const judgeRejects: FindCompaniesReject[] = [];
	for (const verdict of verdicts) {
		const row = keptRows[verdict.index];
		if (!row) continue;
		if (verdict.keep) accepted.push(row);
		else
			judgeRejects.push({
				domain: row.domain,
				reason: verdict.reason ?? "refused without a reason",
				stage: "judge",
			});
	}
	return { accepted, judgeRejects };
}

/** Dollars already banked by earlier rounds. Cost is only known after a call returns, so this can stop the next round but never the one in flight. */
function spentSoFar(ledgers: readonly CostLedger[]): number {
	return CostLedger.merge(...ledgers).total();
}

function buildFeedback(rejects: readonly FindCompaniesReject[]): string[] {
	return groupRejectReasons(rejects);
}

type RoundContext = {
	icp: IcpDoc;
	count: number;
	pastAngles: readonly string[];
	feedback: readonly string[];
	seenDomains: ReadonlySet<string>;
};

type RoundOutcome = {
	plan: SearchPlan;
	filterRejects: FindCompaniesReject[];
	rows: CompanyRow[];
	gateRejects: Reject[];
	keptRows: CompanyRow[];
	verdicts: Verdict[];
	unseenCount: number;
	resultCount: number;
	ledger: CostLedger;
	captures: Record<string, CompanyCapture>;
};

async function runRound(
	ctx: RoundContext,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<RoundOutcome> {
	const synthesized = await deps.synthesize(
		{
			icp: ctx.icp,
			pastAngles: ctx.pastAngles,
			feedback: ctx.feedback,
			today: opts.today,
		},
		opts.env,
	);
	const plan = synthesized.plan;
	const searchLedger = new CostLedger();
	const searched = await deps.search(
		plan,
		buildSearchRequest(
			plan,
			excludedDomains(opts.excludeDomains ?? [], ctx.seenDomains),
		),
		opts.env,
		searchLedger,
	);
	const filtered = filterEntities(searched.results, plan);
	const unseenCount = countUnseen(filtered.rows, ctx.seenDomains);
	const gated = deps.gate(filtered.rows, filtered.results, {
		seenDomains: ctx.seenDomains,
	});
	const candidates = gated.kept.slice(0, ctx.count * JUDGE_CANDIDATE_MULTIPLE);
	const judged =
		candidates.length > 0
			? await deps.judge(ctx.icp, candidates, opts.env, plan.recency)
			: { verdicts: [], ledger: new CostLedger() };
	return {
		plan,
		rows: filtered.rows,
		filterRejects: filtered.rejects,
		gateRejects: gated.rejects,
		keptRows: candidates,
		verdicts: judged.verdicts,
		unseenCount,
		resultCount: searched.results.length,
		ledger: CostLedger.merge(synthesized.ledger, searchLedger, judged.ledger),
		captures: filtered.captures,
	};
}

type RunInput = { icp: IcpDoc; count: number; seenDomains: Set<string> };

type RoundsAccumulator = {
	companies: CompanyRow[];
	rejects: FindCompaniesReject[];
	ledgers: CostLedger[];
	rounds: number;
	status: FindCompaniesStatus;
	searches: SearchPlan[];
	captures: Record<string, CompanyCapture>;
	feedback: string[];
};

const EMPTY_ROUND_FEEDBACK =
	"the previous query matched no companies at all, so it was too narrow: write a broader angle";

type AbsorbedRound = {
	rejects: FindCompaniesReject[];
	accepted: CompanyRow[];
};

/** Records one round's domains as seen and splits its rows into kept and rejected. */
function absorbRound(
	outcome: RoundOutcome,
	seenDomains: Set<string>,
): AbsorbedRound {
	for (const domain of collectDomains(outcome.rows)) seenDomains.add(domain);
	const gateRejects = toGateRejects(outcome.rows, outcome.gateRejects);
	const { accepted, judgeRejects } = applyVerdicts(
		outcome.keptRows,
		outcome.verdicts,
	);
	return {
		rejects: [...outcome.filterRejects, ...gateRejects, ...judgeRejects],
		accepted,
	};
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

type RetryFeedback = { feedback: string[]; emptyRounds: number };

/** A retry over a vendor answer of zero rows earns the generic too-narrow line and counts toward `empty`; a retry over a filter or gate refusal keeps the reject reasons already in `feedback`. */
function retryFeedback(
	feedback: readonly string[],
	resultCount: number,
	emptyRounds: number,
): RetryFeedback {
	if (resultCount !== 0) return { feedback: [...feedback], emptyRounds };
	return {
		feedback: [...feedback, EMPTY_ROUND_FEEDBACK],
		emptyRounds: emptyRounds + 1,
	};
}

async function runRounds(
	input: RunInput,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<RoundsAccumulator> {
	const companies: CompanyRow[] = [];
	const rejects: FindCompaniesReject[] = [];
	const ledgers: CostLedger[] = [];
	const searches: SearchPlan[] = [];
	const captures: Record<string, CompanyCapture> = {};
	const pastAngles: string[] = [...(opts.pastAngles ?? [])];
	const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
	let feedback: string[] = [...(opts.feedback ?? [])];
	let status: FindCompaniesStatus = "short";
	let rounds = 0;
	let emptyRounds = 0;

	for (let round = 0; round < maxRounds; round++) {
		if (spentSoFar(ledgers) >= SPEND_PER_RUN) {
			status = "capped";
			break;
		}
		rounds += 1;
		const outcome = await runRound(
			{
				icp: input.icp,
				count: input.count,
				pastAngles: [...pastAngles],
				feedback: [...feedback],
				seenDomains: input.seenDomains,
			},
			opts,
			deps,
		);
		ledgers.push(outcome.ledger);
		searches.push(outcome.plan);
		pastAngles.push(outcome.plan.angle);
		Object.assign(captures, outcome.captures);
		const absorbed = absorbRound(outcome, input.seenDomains);
		rejects.push(...absorbed.rejects);
		companies.push(...absorbed.accepted);
		feedback = buildFeedback(absorbed.rejects);

		const decision = decideRound(companies.length, input.count, {
			resultCount: outcome.resultCount,
			filteredCount: outcome.rows.length,
			unseenCount: outcome.unseenCount,
		});
		if (decision === "retry") {
			const retried = retryFeedback(feedback, outcome.resultCount, emptyRounds);
			feedback = retried.feedback;
			emptyRounds = retried.emptyRounds;
			continue;
		}
		if (decision !== "continue") {
			status = decision;
			break;
		}
	}
	return {
		companies,
		rejects,
		ledgers,
		rounds,
		status: terminalStatus(status, companies.length, emptyRounds, rounds),
		searches,
		captures,
		feedback,
	};
}

/**
 * Runs the deterministic company-discovery loop: read seen domains, then
 * synthesize, search, gate, and judge one round at a time until `count` is
 * met, three rounds pass, or a round adds no unseen domain. The gate always
 * outranks the count; a rejected row never reaches the result.
 */
export async function findCompanies(
	icp: IcpDoc,
	count: number,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<FindCompaniesResult> {
	const known = await deps.recentDomains(
		opts.env,
		opts.icpId,
		SEEN_DOMAINS_WINDOW_DAYS,
	);
	const seenDomains = new Set(known.map(normalizeDomain));
	const outcome = await runRounds({ icp, count, seenDomains }, opts, deps);
	const companies = outcome.companies.slice(0, count);
	return {
		companies,
		requested: count,
		found: companies.length,
		rounds: outcome.rounds,
		status: outcome.status,
		costDollars: CostLedger.merge(...outcome.ledgers).total(),
		rejects: outcome.rejects,
		searches: outcome.searches,
		captures: outcome.captures,
		seenDomains: [...seenDomains],
		feedback: outcome.feedback,
	};
}
