import { config } from "@/config";
import type {
	CompanyCapture,
	FindCompaniesReject,
	RetrievedPage,
} from "@/core/companies/candidates";
import {
	groupRejectReasons,
	seedExcludedDomains,
} from "@/core/companies/candidates";
import type {
	CompanyRow,
	GateOptions,
	GateResult,
} from "@/core/companies/gate";
import type { JudgeOptions, JudgeResult } from "@/core/companies/judge";
import {
	type retrieveCompanyEvidence,
	toGateRejects,
} from "@/core/companies/proof";
import type { BackfilledRecord } from "@/core/companies/record";
import type { RoundOutcome } from "@/core/companies/round";
import { runRound } from "@/core/companies/round";
import type { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type {
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import type {
	IcpDoc,
	SearchPlan,
	SynthesizeInput,
	SynthesizeResult,
} from "@/core/synthesize";

export type { FindCompaniesReject, RetrievedPage };

const { maxAnglesPerRound: MAX_ANGLES_PER_ROUND } = config.companies;

export type FindCompaniesOptions = {
	icpId: string;
	organizationId: string;
	env: Env;
	today: string;
	requirements: readonly Requirement[];
	pastAngles?: readonly string[];
	feedback?: readonly string[];
	provenRate?: string | null;
	excludeDomains?: readonly string[];
};

export type FindCompaniesDeps = {
	recentDomains: (env: Env, organizationId: string) => Promise<string[]>;
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
	retrieveEvidence: typeof retrieveCompanyEvidence;
	gate: (rows: readonly CompanyRow[], opts: GateOptions) => GateResult;
	judge: (
		requirements: readonly Requirement[],
		rows: readonly CompanyRow[],
		env: Env,
		options?: JudgeOptions,
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
	provenRate?: string | null;
};

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/** How many bounded angles one round asks the planner for based on shortfall. */
export function anglesForRound(
	_requirements: readonly Requirement[],
	shortfall: number,
): number {
	return clamp(Math.ceil(shortfall / 4), 1, MAX_ANGLES_PER_ROUND);
}

function statusForRound(
	companies: readonly CompanyRow[],
	count: number,
	outcome: RoundOutcome,
): FindCompaniesStatus {
	if (companies.length >= count) return "complete";
	if (outcome.resultCount === 0) return "empty";
	return "short";
}

function rejectsForRound(outcome: RoundOutcome): FindCompaniesReject[] {
	return [
		...outcome.filterRejects,
		...toGateRejects(outcome.rows, outcome.gateRejects),
		...outcome.evidenceRejects,
		...outcome.judgeRejects,
	];
}

/**
 * Runs one deterministic discovery round. The durable workflow owns retries
 * and cross-round state so direct callers and production use the same round.
 */
export async function findCompanies(
	icp: IcpDoc,
	count: number,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<FindCompaniesResult> {
	const requirements = opts.requirements;
	const known = await deps.recentDomains(opts.env, opts.organizationId);
	const excluded = seedExcludedDomains(
		[...known, ...(opts.excludeDomains ?? [])],
		icp.seller,
	);
	const outcome = await runRound(
		{
			icp,
			requirements,
			count,
			pastAngles: opts.pastAngles ?? [],
			feedback: opts.feedback ?? [],
			provenRate: opts.provenRate ?? null,
			excluded,
		},
		opts,
		deps,
	);
	const companies = outcome.accepted;
	const rejects = rejectsForRound(outcome);
	const seenDomains = new Set(excluded);
	for (const company of companies) {
		if (company.domain) seenDomains.add(normalizeDomain(company.domain));
	}
	return {
		companies,
		requested: count,
		found: companies.length,
		rounds: 1,
		status: statusForRound(companies, count, outcome),
		costDollars: outcome.ledger.total(),
		rejects,
		searches: outcome.plans,
		captures: outcome.captures,
		seenDomains: [...seenDomains],
		feedback: [
			`Previous round used ${outcome.plans[0]?.source === "exa-agent" ? "agent" : "search"}, admitted ${companies.length} companies; ${Math.max(0, count - companies.length)} companies still needed.`,
			...groupRejectReasons(rejects),
		],
		pages: outcome.pages,
		provenRate: outcome.provenRate,
	};
}
