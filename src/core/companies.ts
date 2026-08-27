import { config } from "@/config";
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
	CompanyEntity,
	ExaResult,
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa";
import type {
	IcpDoc,
	SearchPlan,
	SynthesizeInput,
	SynthesizeResult,
} from "@/core/synthesize";

const {
	maxRounds: MAX_ROUNDS,
	resultsPerRound: RESULTS_PER_ROUND,
	judgeCandidateMultiple: JUDGE_CANDIDATE_MULTIPLE,
	descriptionChars: DESCRIPTION_CHARS,
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

export type FindCompaniesStatus = "complete" | "short" | "exhausted";

export type FindCompaniesReject = {
	domain: string | null;
	reason: string;
	stage: "filter" | "gate" | "judge";
};

export type FindCompaniesResult = {
	companies: CompanyRow[];
	requested: number;
	found: number;
	rounds: number;
	status: FindCompaniesStatus;
	costDollars: number;
	rejects: FindCompaniesReject[];
	searches: SearchPlan[];
};

function buildSearchRequest(plan: SearchPlan): ExaSearchRequest {
	return {
		query: plan.query,
		category: "company",
		numResults: RESULTS_PER_ROUND,
		...(plan.userLocation ? { userLocation: plan.userLocation } : {}),
	};
}

function describeCompany(entity: CompanyEntity): string {
	const facts: string[] = [];
	if (entity.workforceTotal !== null)
		facts.push(`headcount ${entity.workforceTotal}`);
	if (entity.country !== null)
		facts.push(`${entity.city ? `${entity.city}, ` : ""}${entity.country}`);
	if (entity.foundedYear !== null) facts.push(`founded ${entity.foundedYear}`);
	if (entity.revenueAnnual !== null)
		facts.push(`annual revenue ${entity.revenueAnnual} USD`);
	if (entity.fundingTotal !== null)
		facts.push(`funding raised ${entity.fundingTotal} USD`);
	const description = (entity.description ?? "").slice(0, DESCRIPTION_CHARS);
	return [facts.join("; "), description].filter(Boolean).join(". ");
}

function toCompanyRow(result: ExaResult, entity: CompanyEntity): CompanyRow {
	return {
		name: entity.name ?? result.title,
		domain: normalizeDomain(result.url),
		linkedinUrl: null,
		evidenceUrl: result.url,
		signal: describeCompany(entity) || null,
		evidenceDate: result.publishedDate ?? null,
	};
}

function toSearchResult(result: ExaResult): SearchResult {
	return {
		...(result.score !== undefined ? { score: result.score } : {}),
	};
}

function entityRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): string | null {
	const { country } = entity;
	if (plan.countries.length > 0 && country !== null) {
		const allowed = plan.countries.some(
			(name) => name.toLowerCase() === country.toLowerCase(),
		);
		if (!allowed) return `headquarters in ${country}`;
	}
	const staff = entity.workforceTotal;
	if (staff === null) return null;
	if (plan.maxWorkforce !== null && staff > plan.maxWorkforce)
		return `headcount ${staff} above the limit of ${plan.maxWorkforce}`;
	if (plan.minWorkforce !== null && staff < plan.minWorkforce)
		return `headcount ${staff} below the floor of ${plan.minWorkforce}`;
	return null;
}

type FilterOutcome = {
	rows: CompanyRow[];
	results: SearchResult[];
	rejects: FindCompaniesReject[];
};

/** Keeps the results whose structured record satisfies the plan's country and headcount limits. A record that states nothing is kept for the judge. */
function filterEntities(
	results: readonly ExaResult[],
	plan: SearchPlan,
): FilterOutcome {
	const outcome: FilterOutcome = { rows: [], results: [], rejects: [] };
	for (const result of results) {
		const entity = result.company;
		if (!entity) {
			outcome.rejects.push({
				domain: normalizeDomain(result.url),
				reason: "no company record in the result",
				stage: "filter",
			});
			continue;
		}
		const reason = entityRejectReason(entity, plan);
		if (reason) {
			outcome.rejects.push({
				domain: normalizeDomain(result.url),
				reason,
				stage: "filter",
			});
			continue;
		}
		outcome.rows.push(toCompanyRow(result, entity));
		outcome.results.push(toSearchResult(result));
	}
	return outcome;
}

function rowDomain(row: CompanyRow): string | null {
	return row.domain ? normalizeDomain(row.domain) : null;
}

function collectDomains(rows: readonly CompanyRow[]): Set<string> {
	const domains = new Set<string>();
	for (const row of rows) {
		const domain = rowDomain(row);
		if (domain) domains.add(domain);
	}
	return domains;
}

function countUnseen(
	rows: readonly CompanyRow[],
	seen: ReadonlySet<string>,
): number {
	let count = 0;
	for (const row of rows) {
		const domain = rowDomain(row);
		if (domain && !seen.has(domain)) count += 1;
	}
	return count;
}

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
	const pastAngles: string[] = [];
	const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
	let feedback: string[] = [];
	let status: FindCompaniesStatus = "short";
	let rounds = 0;

	for (let round = 0; round < maxRounds; round++) {
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
	return { companies, rejects, ledgers, rounds, status, searches };
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
	};
}
