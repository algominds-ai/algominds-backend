import { config } from "@/config";
import type {
	FindCompaniesDeps,
	FindCompaniesOptions,
	RetrievedPage,
} from "@/core/companies";
import { anglesForRound } from "@/core/companies";
import type {
	CompanyCapture,
	FindCompaniesReject,
} from "@/core/companies/candidates";
import {
	buildSearchRequest,
	excludedDomains,
	filterEntities,
} from "@/core/companies/candidates";
import type { CompanyRow, Reject } from "@/core/companies/gate";
import {
	identifyCompanyRows,
	verifiedLinkedInCompanyUrl,
} from "@/core/companies/identity";
import { decideRows, provenRate } from "@/core/companies/judge";
import { applyJudgeReasons } from "@/core/companies/proof";
import { applyRecords } from "@/core/companies/record";
import { addPartialSpend, CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type { ExaResult, ExaSearchResult } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import type { IcpDoc, SearchPlan, SynthesizeResult } from "@/core/synthesize";

const {
	judgeCandidateMultiple: JUDGE_CANDIDATE_MULTIPLE,
	resultsPerRound: MAX_CANDIDATES,
} = config.companies;

export type RoundContext = {
	icp: IcpDoc;
	requirements: readonly Requirement[];
	count: number;
	pastAngles: readonly string[];
	feedback: readonly string[];
	provenRate: string | null;
	excluded: ReadonlySet<string>;
};

export type RoundOutcome = {
	plans: SearchPlan[];
	filterRejects: FindCompaniesReject[];
	rows: CompanyRow[];
	gateRejects: Reject[];
	evidenceRejects: FindCompaniesReject[];
	accepted: CompanyRow[];
	judgeRejects: FindCompaniesReject[];
	provenRate: string | null;
	resultCount: number;
	ledger: CostLedger;
	captures: Record<string, CompanyCapture>;
	pages: RetrievedPage[];
};

/** Every distinct company domain an agent round named that this run may still return, the list its record backfill is asked for. An excluded domain is never looked up, so a paid record never resurrects a company the account already holds. */
function agentDomains(
	results: readonly ExaResult[],
	excluded: ReadonlySet<string>,
): string[] {
	const domains = new Set<string>();
	for (const result of results) {
		const domain = normalizeDomain(result.url);
		if (!excluded.has(domain)) domains.add(domain);
	}
	return [...domains];
}

/** Keep one candidate per domain and retain evidence supplied by every angle. */
function dedupeByDomain(results: readonly ExaResult[]): ExaResult[] {
	const deduped = new Map<string, ExaResult>();
	for (const result of results) {
		const domain = normalizeDomain(result.url);
		const prior = deduped.get(domain);
		deduped.set(
			domain,
			prior
				? {
						...prior,
						evidence: [...(prior.evidence ?? []), ...(result.evidence ?? [])],
					}
				: result,
		);
	}
	return [...deduped.values()];
}

type SearchAllInput = {
	plans: readonly SearchPlan[];
	excluded: readonly string[];
	opts: FindCompaniesOptions;
	deps: FindCompaniesDeps;
	ledger: CostLedger;
};

/** Runs a company search for every angle a search round wrote, one after another to respect Exa's own rate limit, and returns their results deduped by domain under the first search's request id. */
async function searchAllPlans(input: SearchAllInput): Promise<ExaSearchResult> {
	const { plans, excluded, opts, deps, ledger } = input;
	const results: ExaResult[] = [];
	let requestId = "";
	for (const plan of plans) {
		const found = await deps.search(
			plan,
			buildSearchRequest(plan, excluded),
			opts.env,
			ledger,
		);
		if (!requestId) requestId = found.requestId;
		results.push(...found.results);
	}
	return { requestId, results: dedupeByDomain(results) };
}

type GatherInput = {
	ctx: RoundContext;
	opts: FindCompaniesOptions;
	deps: FindCompaniesDeps;
	route: SynthesizeResult["route"];
	plans: readonly SearchPlan[];
	ledger: CostLedger;
};

/** One round's vendor results: an agent fan-out with every company's own record backfilled onto it, or every plan's company search, deduped by domain. */
async function gather(input: GatherInput): Promise<ExaSearchResult> {
	const { ctx, opts, deps, route, plans, ledger } = input;
	if (plans.length === 0) return { requestId: "", results: [] };
	const excluded = excludedDomains([], ctx.excluded);
	if (route === "search") {
		return searchAllPlans({ plans, excluded, opts, deps, ledger });
	}
	const found = await deps.agentRound(plans, excluded, opts.env, ledger);
	const results = dedupeByDomain(found.results);
	const filled = await deps.backfill(
		agentDomains(results, ctx.excluded),
		opts.env,
		ledger,
	);
	return { ...found, results: applyRecords(results, filled) };
}

function knownExcludedIdentities(
	rows: readonly CompanyRow[],
	excluded: ReadonlySet<string>,
): Set<string> {
	return new Set(
		rows
			.filter((row) => row.domain && excluded.has(normalizeDomain(row.domain)))
			.map((row) => verifiedLinkedInCompanyUrl(row.linkedinUrl))
			.filter((url): url is string => url !== null),
	);
}

export async function runRound(
	ctx: RoundContext,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<RoundOutcome> {
	const synthesized = await deps.synthesize(
		{
			icp: ctx.icp,
			requirements: ctx.requirements,
			pastAngles: ctx.pastAngles,
			feedback: ctx.feedback,
			today: opts.today,
			angles: anglesForRound(ctx.requirements, ctx.count),
			provenRate: ctx.provenRate,
		},
		opts.env,
	);
	const { route, plans } = synthesized;
	const first = plans[0];
	if (!first) throw new Error("findCompanies: the planner produced no angle");
	const vendorLedger = new CostLedger();
	try {
		const searched = await gather({
			ctx,
			opts,
			deps,
			route,
			plans,
			ledger: vendorLedger,
		});
		const filtered = filterEntities(searched.results, first, opts.today);
		const gated = deps.gate(filtered.rows, {
			seenDomains: ctx.excluded,
		});
		const candidateLimit = Math.min(
			ctx.count * JUDGE_CANDIDATE_MULTIPLE,
			MAX_CANDIDATES,
		);
		const judgedRows = gated.kept.slice(0, candidateLimit);
		const evidence = await deps.retrieveEvidence(
			{
				rows: judgedRows,
				captures: filtered.captures,
				requirements: ctx.requirements,
			},
			opts.env,
			vendorLedger,
		);
		const identified = identifyCompanyRows(judgedRows, evidence.evidenceByRow);
		const judged = identified.rows.length
			? await deps.judge(ctx.requirements, identified.rows, opts.env, {
					evidenceByRow: identified.evidenceByRow,
					today: opts.today,
					profile: ctx.icp,
				})
			: { verdicts: [], ledger: new CostLedger() };
		applyJudgeReasons(filtered.captures, identified.rows, judged.verdicts);
		const decision = decideRows({
			requirements: ctx.requirements,
			rows: identified.rows,
			verdicts: judged.verdicts,
			excluded: ctx.excluded,
			excludedLinkedInUrls: knownExcludedIdentities(
				filtered.rows,
				ctx.excluded,
			),
		});
		return {
			plans: [...plans],
			rows: filtered.rows,
			filterRejects: filtered.rejects,
			gateRejects: gated.rejects,
			evidenceRejects: identified.rejects,
			accepted: decision.stored,
			judgeRejects: decision.rejects,
			provenRate: provenRate(ctx.requirements, judged.verdicts),
			resultCount: searched.results.length,
			ledger: CostLedger.merge(synthesized.ledger, vendorLedger, judged.ledger),
			captures: filtered.captures,
			pages: evidence.pages,
		};
	} catch (error) {
		throw addPartialSpend(
			error,
			synthesized.ledger.total() + vendorLedger.total(),
		);
	}
}
