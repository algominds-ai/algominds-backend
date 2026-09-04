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
	countUnseen,
	excludedDomains,
	filterEntities,
} from "@/core/companies/candidates";
import { decideRows, provenRate } from "@/core/companies/decide";
import {
	applyEvidenceChecks,
	applyJudgeReasons,
	demandsEvidenceProof,
	toEvidenceRejects,
	verifyEvidenceRows,
} from "@/core/companies/evidence";
import type { CompanyRow, Reject } from "@/core/companies/gate";
import { withEvidence } from "@/core/companies/proving";
import { applyRecords } from "@/core/companies/record";
import { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import type { QuoteCheckReason } from "@/core/providers/exa/contents";
import type { ExaResult, ExaSearchResult } from "@/core/providers/exa/search";
import type { Requirement } from "@/core/requirements";
import { hardPageRequirements } from "@/core/requirements";
import type { IcpDoc, SearchPlan, SynthesizeResult } from "@/core/synthesize";

const { judgeCandidateMultiple: JUDGE_CANDIDATE_MULTIPLE } = config.companies;

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

type GatherInput = {
	ctx: RoundContext;
	opts: FindCompaniesOptions;
	deps: FindCompaniesDeps;
	route: SynthesizeResult["route"];
	plans: readonly SearchPlan[];
	ledger: CostLedger;
};

/** One round's vendor results: an agent fan-out with every company's own record backfilled onto it, or one company search. */
async function gather(input: GatherInput): Promise<ExaSearchResult> {
	const { ctx, opts, deps, route, plans, ledger } = input;
	const first = plans[0];
	if (!first) return { requestId: "", results: [] };
	const excluded = excludedDomains([], ctx.excluded);
	if (route === "search") {
		return deps.search(
			first,
			buildSearchRequest(first, excluded),
			opts.env,
			ledger,
		);
	}
	const found = await deps.agentRound(plans, excluded, opts.env, ledger);
	const filled = await deps.backfill(
		agentDomains(found.results, ctx.excluded),
		opts.env,
		ledger,
	);
	return { ...found, results: applyRecords(found.results, filled) };
}

type ProveInput = {
	deps: FindCompaniesDeps;
	requirements: readonly Requirement[];
	candidates: readonly CompanyRow[];
	env: Env;
	ledger: CostLedger;
};

type ProvedCandidates = {
	rows: CompanyRow[];
	pages: RetrievedPage[];
	checks: Record<string, QuoteCheckReason>;
};

/**
 * Every candidate of a search round with the page proving the round's hard
 * page requirement attached, so the one judge call that follows sees the
 * evidence and no second pass is needed. A candidate no page was found for
 * keeps its own row, and the judge leaves that requirement unproven. A page
 * this search itself retrieved is already grounded — the quote is a highlight
 * drawn from that same crawl — so the row's check is `found` without a second
 * fetch to confirm it.
 */
async function proveCandidates(input: ProveInput): Promise<ProvedCandidates> {
	const { deps, requirements, candidates, env, ledger } = input;
	const demand = hardPageRequirements(requirements)[0];
	if (!demand) return { rows: [...candidates], pages: [], checks: {} };
	const proven = await deps.prove(candidates, demand, env, ledger);
	const rows = [...candidates];
	const pages: RetrievedPage[] = [];
	const checks: Record<string, QuoteCheckReason> = {};
	for (const entry of proven) {
		const row = rows[entry.index];
		if (!row || entry.hit === null) continue;
		rows[entry.index] = withEvidence(row, entry.hit, demand);
		if (row.domain !== null) {
			pages.push({
				domain: row.domain,
				url: entry.hit.url,
				text: entry.hit.text,
			});
			checks[row.domain] = "found";
		}
	}
	return { rows, pages, checks };
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
	const searched = await gather({
		ctx,
		opts,
		deps,
		route,
		plans,
		ledger: vendorLedger,
	});
	const filtered = filterEntities(searched.results, first, opts.today);
	const unseenCount = countUnseen(filtered.rows, ctx.excluded);
	const gated = deps.gate(filtered.rows, filtered.results, {
		seenDomains: ctx.excluded,
	});
	const candidates = gated.kept.slice(0, ctx.count * JUDGE_CANDIDATE_MULTIPLE);
	const evidenceLedger = new CostLedger();
	const checked = demandsEvidenceProof(first)
		? await verifyEvidenceRows(candidates, opts.env, evidenceLedger)
		: { kept: candidates, rejects: [], checks: {}, pages: [] };
	applyEvidenceChecks(filtered.captures, checked.checks);
	const proved =
		route === "search"
			? await proveCandidates({
					deps,
					requirements: ctx.requirements,
					candidates: checked.kept,
					env: opts.env,
					ledger: evidenceLedger,
				})
			: { rows: checked.kept, pages: checked.pages, checks: {} };
	applyEvidenceChecks(filtered.captures, proved.checks);
	const judged =
		proved.rows.length > 0
			? await deps.judge(ctx.requirements, proved.rows, opts.env)
			: { verdicts: [], ledger: new CostLedger() };
	applyJudgeReasons(filtered.captures, proved.rows, judged.verdicts);
	const decision = decideRows({
		requirements: ctx.requirements,
		rows: proved.rows,
		verdicts: judged.verdicts,
		excluded: ctx.excluded,
	});
	return {
		plans: [...plans],
		rows: filtered.rows,
		filterRejects: filtered.rejects,
		gateRejects: gated.rejects,
		evidenceRejects: toEvidenceRejects(candidates, checked.rejects),
		accepted: decision.stored,
		judgeRejects: decision.rejects,
		provenRate: provenRate(ctx.requirements, judged.verdicts),
		unseenCount,
		resultCount: searched.results.length,
		ledger: CostLedger.merge(
			synthesized.ledger,
			vendorLedger,
			evidenceLedger,
			judged.ledger,
		),
		captures: filtered.captures,
		pages: proved.pages,
	};
}
