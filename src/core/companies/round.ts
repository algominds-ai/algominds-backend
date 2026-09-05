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
import type { Verdict } from "@/core/companies/judge";
import { decideRows, provenRate } from "@/core/companies/judge";
import {
	applyEvidenceChecks,
	demandsEvidenceProof,
	toEvidenceRejects,
	verifyEvidenceRows,
} from "@/core/companies/proof";
import { proveAndJudge } from "@/core/companies/proving";
import { applyRecords } from "@/core/companies/record";
import { addPartialSpend, CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type { ExaResult, ExaSearchResult } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import type { IcpDoc, SearchPlan, SynthesizeResult } from "@/core/synthesize";

const { judgeCandidateMultiple: JUDGE_CANDIDATE_MULTIPLE } = config.companies;
const MAX_JUDGE_SLICES_PER_ROUND = 3;

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
	unseenCount: number;
	resultCount: number;
	ledger: CostLedger;
	captures: Record<string, CompanyCapture>;
	pages: RetrievedPage[];
	unjudgedDomains: string[];
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

/** The results of every plan a search round ran, kept once by domain: the first plan to name a domain wins. */
function dedupeByDomain(results: readonly ExaResult[]): ExaResult[] {
	const seen = new Set<string>();
	const deduped: ExaResult[] = [];
	for (const result of results) {
		const domain = normalizeDomain(result.url);
		if (seen.has(domain)) continue;
		seen.add(domain);
		deduped.push(result);
	}
	return deduped;
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
	const filled = await deps.backfill(
		agentDomains(found.results, ctx.excluded),
		opts.env,
		ledger,
	);
	return { ...found, results: applyRecords(found.results, filled) };
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
		const unseenCount = filtered.rows.filter(
			(row) => row.domain && !ctx.excluded.has(normalizeDomain(row.domain)),
		).length;
		const gated = deps.gate(filtered.rows, {
			seenDomains: ctx.excluded,
		});
		const judged = await judgeSlices({
			ctx,
			opts,
			deps,
			route,
			first,
			gated: gated.kept,
			captures: filtered.captures,
		});
		const unjudgedDomains = gated.kept
			.slice(judged.judgedCount)
			.map((row) => row.domain)
			.filter((domain) => domain !== null);
		return {
			plans: [...plans],
			rows: filtered.rows,
			filterRejects: filtered.rejects,
			gateRejects: gated.rejects,
			evidenceRejects: judged.evidenceRejects,
			accepted: judged.accepted,
			judgeRejects: judged.judgeRejects,
			provenRate: provenRate(ctx.requirements, judged.verdicts),
			unseenCount,
			resultCount: searched.results.length,
			ledger: CostLedger.merge(synthesized.ledger, vendorLedger, judged.ledger),
			captures: filtered.captures,
			pages: judged.pages,
			unjudgedDomains,
		};
	} catch (error) {
		throw addPartialSpend(
			error,
			synthesized.ledger.total() + vendorLedger.total(),
		);
	}
}

type SliceInput = {
	ctx: RoundContext;
	opts: FindCompaniesOptions;
	deps: FindCompaniesDeps;
	route: SynthesizeResult["route"];
	first: SearchPlan;
	gated: readonly CompanyRow[];
	captures: Record<string, CompanyCapture>;
};

type SliceOutcome = {
	accepted: CompanyRow[];
	judgeRejects: FindCompaniesReject[];
	evidenceRejects: FindCompaniesReject[];
	verdicts: Verdict[];
	pages: RetrievedPage[];
	ledger: CostLedger;
	judgedCount: number;
};

/** Checks, proves and judges one slice of the gated candidates. */
async function judgeOneSlice(
	input: SliceInput,
	candidates: readonly CompanyRow[],
): Promise<SliceOutcome> {
	const { ctx, opts, deps, route, first, captures } = input;
	const ledger = new CostLedger();
	try {
		const checked = demandsEvidenceProof(first)
			? await verifyEvidenceRows(candidates, opts.env, ledger)
			: { kept: candidates, rejects: [], checks: {}, pages: [] };
		applyEvidenceChecks(captures, checked.checks);
		const proved = await proveAndJudge({
			route,
			deps,
			requirements: ctx.requirements,
			checked,
			env: opts.env,
			ledger,
			captures,
			today: opts.today,
		});
		const decision = decideRows({
			requirements: ctx.requirements,
			rows: proved.rows,
			verdicts: proved.verdicts,
			excluded: ctx.excluded,
		});
		return {
			accepted: decision.stored,
			judgeRejects: decision.rejects,
			evidenceRejects: toEvidenceRejects(candidates, checked.rejects),
			verdicts: [...proved.verdicts],
			pages: proved.pages,
			ledger: CostLedger.merge(ledger, proved.ledger),
			judgedCount: candidates.length,
		};
	} catch (error) {
		throw addPartialSpend(error, ledger.total());
	}
}

/** Judges the gated candidates one slice at a time, at most `MAX_JUDGE_SLICES_PER_ROUND` slices, moving on only while the round is short of its count; brand collapse applies within a slice only. */
async function judgeSlices(input: SliceInput): Promise<SliceOutcome> {
	const size = input.ctx.count * JUDGE_CANDIDATE_MULTIPLE;
	const total: SliceOutcome = {
		accepted: [],
		judgeRejects: [],
		evidenceRejects: [],
		verdicts: [],
		pages: [],
		ledger: new CostLedger(),
		judgedCount: 0,
	};
	for (let slice = 0; slice < MAX_JUDGE_SLICES_PER_ROUND; slice++) {
		const at = slice * size;
		if (at >= input.gated.length || total.accepted.length >= input.ctx.count) {
			break;
		}
		try {
			const judged = await judgeOneSlice(
				input,
				input.gated.slice(at, at + size),
			);
			total.judgedCount = at + judged.judgedCount;
			total.accepted.push(...judged.accepted);
			total.judgeRejects.push(...judged.judgeRejects);
			total.evidenceRejects.push(...judged.evidenceRejects);
			total.verdicts.push(...judged.verdicts);
			total.pages.push(...judged.pages);
			total.ledger = CostLedger.merge(total.ledger, judged.ledger);
		} catch (error) {
			throw addPartialSpend(error, total.ledger.total());
		}
	}
	return total;
}
