import type { FindCompaniesDeps } from "@/core/companies";
import type {
	CompanyCapture,
	RetrievedPage,
} from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type { RequirementEvidence, Verdict } from "@/core/companies/judge";
import type { ProvenRow, ProvingHit } from "@/core/companies/proof";
import {
	applyEvidenceChecks,
	applyJudgeReasons,
	applyRowEvidence,
	provingDemand,
	withEvidence,
} from "@/core/companies/proof";
import { CostLedger } from "@/core/cost";
import type { QuoteCheckReason } from "@/core/providers/exa/contents";
import type { Requirement } from "@/core/requirements";
import { hardPageRequirements } from "@/core/requirements";
import type { SynthesizeResult } from "@/core/synthesize";

type ProveInput = {
	deps: FindCompaniesDeps;
	requirements: readonly Requirement[];
	candidates: readonly CompanyRow[];
	env: Env;
	ledger: CostLedger;
	today: string;
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
	const { deps, requirements, candidates, env, ledger, today } = input;
	const demands = hardPageRequirements(requirements);
	const state: ProvedCandidates = {
		rows: [...candidates],
		pages: [],
		checks: {},
		evidenceByRow: new Map(),
	};
	for (const [demandIndex, demand] of demands.entries()) {
		const proven = await deps.prove(
			candidates,
			provingDemand(demand, today),
			env,
			ledger,
		);
		for (const entry of proven) {
			applyProvenEntry(state, demand, demandIndex === 0, entry);
		}
	}
	return state;
}

type CheckedRows = {
	kept: readonly CompanyRow[];
	pages: readonly RetrievedPage[];
	checks: Record<string, QuoteCheckReason>;
};

function withoutEvidence(row: CompanyRow): CompanyRow {
	return {
		...row,
		evidenceUrl: null,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		evidenceDate: null,
	};
}

type ReproveInput = {
	deps: FindCompaniesDeps;
	requirements: readonly Requirement[];
	checked: CheckedRows;
	env: Env;
	ledger: CostLedger;
	today: string;
};

/** The rows with every one whose quote the page check did not find stripped of its evidence and sent through the proving pass; rows the check found, or that no check ran on, are returned as they were. */
async function reproveUnverified(
	input: ReproveInput,
): Promise<ProvedCandidates> {
	const { deps, requirements, checked, env, ledger, today } = input;
	const unverified = checked.kept.flatMap((row, index) => {
		const check = row.domain === null ? undefined : checked.checks[row.domain];
		return check !== undefined && check !== "found" ? [index] : [];
	});
	const rows = [...checked.kept];
	const pages = [...checked.pages];
	if (unverified.length === 0) {
		return { rows, pages, checks: {}, evidenceByRow: new Map() };
	}
	const proved = await proveCandidates({
		deps,
		requirements,
		candidates: unverified.flatMap((index) => {
			const row = rows[index];
			return row ? [withoutEvidence(row)] : [];
		}),
		env,
		ledger,
		today,
	});
	const evidenceByRow: EvidenceByRow = new Map();
	unverified.forEach((rowIndex, provedIndex) => {
		const provedRow = proved.rows[provedIndex];
		if (provedRow) rows[rowIndex] = provedRow;
		const evidence = proved.evidenceByRow.get(provedIndex);
		if (evidence) evidenceByRow.set(rowIndex, evidence);
	});
	return {
		rows,
		pages: [...pages, ...proved.pages],
		checks: proved.checks,
		evidenceByRow,
	};
}

export type ProveAndJudgeInput = {
	route: SynthesizeResult["route"];
	deps: FindCompaniesDeps;
	requirements: readonly Requirement[];
	checked: CheckedRows;
	env: Env;
	ledger: CostLedger;
	captures: Record<string, CompanyCapture>;
	today: string;
};

export type ProveAndJudgeOutcome = {
	rows: CompanyRow[];
	pages: RetrievedPage[];
	verdicts: readonly Verdict[];
	ledger: CostLedger;
};

/**
 * Fetches every proved row's own homepage and folds it onto `evidenceByRow`
 * under the `"homepage"` key, so the judge weighs the company's own current
 * statement next to its record. A domain no homepage was found for is left
 * exactly as it was.
 */
async function attachHomepages(
	deps: FindCompaniesDeps,
	proved: ProvedCandidates,
	env: Env,
	ledger: CostLedger,
): Promise<void> {
	const domains = [
		...new Set(proved.rows.flatMap((row) => (row.domain ? [row.domain] : []))),
	];
	if (domains.length === 0) return;
	const homepages = await deps.homepages(domains, env, ledger);
	const byDomain = new Map(homepages.map((page) => [page.domain, page]));
	proved.rows.forEach((row, index) => {
		const homepage = row.domain ? byDomain.get(row.domain) : undefined;
		if (!homepage) return;
		const perRow =
			proved.evidenceByRow.get(index) ?? new Map<string, RequirementEvidence>();
		perRow.set("homepage", { url: homepage.url, quote: homepage.text });
		proved.evidenceByRow.set(index, perRow);
	});
}

/** Proves what the round's rows still need proving, then judges them, recording the evidence and the verdicts onto `captures`. */
export async function proveAndJudge(
	input: ProveAndJudgeInput,
): Promise<ProveAndJudgeOutcome> {
	const { route, deps, requirements, checked, env, ledger, captures, today } =
		input;
	const proved =
		route === "search"
			? await proveCandidates({
					deps,
					requirements,
					candidates: [...checked.kept],
					env,
					ledger,
					today,
				})
			: await reproveUnverified({
					deps,
					requirements,
					checked,
					env,
					ledger,
					today,
				});
	applyEvidenceChecks(captures, proved.checks);
	applyRowEvidence(captures, proved.rows);
	await attachHomepages(deps, proved, env, ledger);
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
