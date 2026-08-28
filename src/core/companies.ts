import { config } from "@/config";
import type {
	CompanyCapture,
	FindCompaniesReject,
} from "@/core/company-candidates";
import {
	buildSearchRequest,
	collectDomains,
	countUnseen,
	filterEntities,
} from "@/core/company-candidates";
import { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type {
	CompanyRow,
	GateOptions,
	GateResult,
	Reject,
	SearchResult,
} from "@/core/gate";
import type { JudgeResult, Verdict } from "@/core/judge";
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
	freshnessDays?: number;
	scoreFloor?: number;
	maxRounds?: number;
};

export type FindCompaniesDeps = {
	recentDomains: (env: Env, icpId: string, days: number) => Promise<string[]>;
	synthesize: (input: SynthesizeInput, env: Env) => Promise<SynthesizeResult>;
	search: (
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
	) => Promise<JudgeResult>;
};

export type FindCompaniesStatus = "complete" | "short" | "exhausted" | "capped";

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
				reason: verdict.reason,
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
	return Array.from(new Set(rejects.map((reject) => reject.reason)));
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
	ledger: CostLedger;
	captures: Record<string, CompanyCapture>;
};

async function runRound(
	ctx: RoundContext,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<RoundOutcome> {
	const synthesized = await deps.synthesize(
		{ icp: ctx.icp, pastAngles: ctx.pastAngles, feedback: ctx.feedback },
		opts.env,
	);
	const plan = synthesized.plan;
	const searchLedger = new CostLedger();
	const searched = await deps.search(
		buildSearchRequest(plan),
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
			? await deps.judge(ctx.icp, candidates, opts.env)
			: { verdicts: [], ledger: new CostLedger() };
	return {
		plan,
		rows: filtered.rows,
		filterRejects: filtered.rejects,
		gateRejects: gated.rejects,
		keptRows: candidates,
		verdicts: judged.verdicts,
		unseenCount,
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
};

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
	const pastAngles: string[] = [];
	const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
	let feedback: string[] = [];
	let status: FindCompaniesStatus = "short";
	let rounds = 0;

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
				pastAngles,
				feedback,
				seenDomains: input.seenDomains,
			},
			opts,
			deps,
		);
		ledgers.push(outcome.ledger);
		searches.push(outcome.plan);
		pastAngles.push(outcome.plan.angle);
		Object.assign(captures, outcome.captures);
		for (const domain of collectDomains(outcome.rows))
			input.seenDomains.add(domain);

		const gateRejects = toGateRejects(outcome.rows, outcome.gateRejects);
		const { accepted, judgeRejects } = applyVerdicts(
			outcome.keptRows,
			outcome.verdicts,
		);
		const roundRejects = [
			...outcome.filterRejects,
			...gateRejects,
			...judgeRejects,
		];
		rejects.push(...roundRejects);
		companies.push(...accepted);
		feedback = buildFeedback(roundRejects);

		if (companies.length >= input.count) {
			status = "complete";
			break;
		}
		if (outcome.unseenCount === 0) {
			status = "exhausted";
			break;
		}
	}
	return { companies, rejects, ledgers, rounds, status, searches, captures };
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
	};
}
