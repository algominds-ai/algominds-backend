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
import type { RequirementEvidence, Verdict } from "@/core/companies/judge";
import { decideRows, provenRate } from "@/core/companies/judge";
import type { ProvenRow, ProvingHit } from "@/core/companies/proof";
import {
	applyEvidenceChecks,
	applyJudgeReasons,
	demandsEvidenceProof,
	toEvidenceRejects,
	verifyEvidenceRows,
	withEvidence,
} from "@/core/companies/proof";
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

type EvidenceByRow = Map<number, Map<string, RequirementEvidence>>;

type ProvedCandidates = {
	rows: CompanyRow[];
	pages: RetrievedPage[];
	checks: Record<string, QuoteCheckReason>;
	evidenceByRow: EvidenceByRow;
};

function recordRequirementEvidence(
	evidenceByRow: EvidenceByRow,
	index: number,
	requirementId: string,
	hit: ProvingHit,
): void {
	const perRow =
		evidenceByRow.get(index) ?? new Map<string, RequirementEvidence>();
	perRow.set(requirementId, { url: hit.url, quote: hit.quote });
	evidenceByRow.set(index, perRow);
}

/** One requirement's proven hit folded onto the round's rows, pages, checks and per-requirement evidence. The first hard page requirement also lands on the row's own single evidence slot, for the display fields that read it. */
function applyProvenEntry(
	state: ProvedCandidates,
	demand: Requirement,
	isPrimary: boolean,
	entry: ProvenRow,
): void {
	const row = state.rows[entry.index];
	if (!row || entry.hit === null) return;
	if (isPrimary) {
		state.rows[entry.index] = withEvidence(row, entry.hit, demand);
		if (row.domain !== null) state.checks[row.domain] = "found";
	}
	if (row.domain !== null) {
		state.pages.push({
			domain: row.domain,
			url: entry.hit.url,
			text: entry.hit.text,
		});
	}
	recordRequirementEvidence(
		state.evidenceByRow,
		entry.index,
		demand.id,
		entry.hit,
	);
}

/**
 * Every candidate of a search round with the page proving each of the round's
 * hard page requirements attached, so the one judge call that follows sees
 * every requirement's own evidence and no second pass is needed.
 * `evidenceByRow` carries every requirement's page, keyed by requirement id,
 * so the judge is never left weighing a second or third page requirement on
 * the first one's proof. A candidate no page was found for keeps its own row,
 * and the judge leaves that requirement unproven.
 */
async function proveCandidates(input: ProveInput): Promise<ProvedCandidates> {
	const { deps, requirements, candidates, env, ledger } = input;
	const demands = hardPageRequirements(requirements);
	const state: ProvedCandidates = {
		rows: [...candidates],
		pages: [],
		checks: {},
		evidenceByRow: new Map(),
	};
	for (const [demandIndex, demand] of demands.entries()) {
		const proven = await deps.prove(candidates, demand, env, ledger);
		for (const entry of proven) {
			applyProvenEntry(state, demand, demandIndex === 0, entry);
		}
	}
	return state;
}

type ProveAndJudgeInput = {
	route: SynthesizeResult["route"];
	deps: FindCompaniesDeps;
	requirements: readonly Requirement[];
	checked: { kept: readonly CompanyRow[]; pages: readonly RetrievedPage[] };
	env: Env;
	ledger: CostLedger;
	captures: Record<string, CompanyCapture>;
};

type ProveAndJudgeOutcome = {
	rows: CompanyRow[];
	pages: RetrievedPage[];
	verdicts: readonly Verdict[];
	ledger: CostLedger;
};

/** Proves every hard page requirement a search round demands, then judges the result — an agent round already carries its own cited evidence, so it skips straight to the judge. Both stages record what they found onto `captures`, for the read routes to see. */
async function proveAndJudge(
	input: ProveAndJudgeInput,
): Promise<ProveAndJudgeOutcome> {
	const { route, deps, requirements, checked, env, ledger, captures } = input;
	const proved =
		route === "search"
			? await proveCandidates({
					deps,
					requirements,
					candidates: [...checked.kept],
					env,
					ledger,
				})
			: {
					rows: [...checked.kept],
					pages: [...checked.pages],
					checks: {},
					evidenceByRow: new Map(),
				};
	applyEvidenceChecks(captures, proved.checks);
	const judged =
		proved.rows.length > 0
			? await deps.judge(requirements, proved.rows, env, proved.evidenceByRow)
			: { verdicts: [], ledger: new CostLedger() };
	applyJudgeReasons(captures, proved.rows, judged.verdicts);
	return {
		rows: proved.rows,
		pages: proved.pages,
		verdicts: judged.verdicts,
		ledger: judged.ledger,
	};
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
	const unseenCount = filtered.rows.filter(
		(row) => row.domain && !ctx.excluded.has(normalizeDomain(row.domain)),
	).length;
	const gated = deps.gate(filtered.rows, filtered.results, {
		seenDomains: ctx.excluded,
	});
	const candidates = gated.kept.slice(0, ctx.count * JUDGE_CANDIDATE_MULTIPLE);
	const evidenceLedger = new CostLedger();
	const checked = demandsEvidenceProof(first)
		? await verifyEvidenceRows(candidates, opts.env, evidenceLedger)
		: { kept: candidates, rejects: [], checks: {}, pages: [] };
	applyEvidenceChecks(filtered.captures, checked.checks);
	const proved = await proveAndJudge({
		route,
		deps,
		requirements: ctx.requirements,
		checked,
		env: opts.env,
		ledger: evidenceLedger,
		captures: filtered.captures,
	});
	const decision = decideRows({
		requirements: ctx.requirements,
		rows: proved.rows,
		verdicts: proved.verdicts,
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
		provenRate: provenRate(ctx.requirements, proved.verdicts),
		unseenCount,
		resultCount: searched.results.length,
		ledger: CostLedger.merge(
			synthesized.ledger,
			vendorLedger,
			evidenceLedger,
			proved.ledger,
		),
		captures: filtered.captures,
		pages: proved.pages,
	};
}
