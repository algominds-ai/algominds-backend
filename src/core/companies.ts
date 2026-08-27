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
	ExaResult,
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa";
import type { IcpDoc, SearchShape, SynthesizeResult } from "@/core/synthesize";

const MAX_ROUNDS = 3;
const RESULTS_PER_ROUND = 5;
const SEEN_DOMAINS_WINDOW_DAYS = 90;
const DEFAULT_FRESHNESS_DAYS = 90;
const DEFAULT_SCORE_FLOOR = 0.5;

const SUMMARY_PROPERTIES: Record<string, { type: "string" }> = {
	name: { type: "string" },
	domain: { type: "string" },
	linkedinUrl: { type: "string" },
	signal: { type: "string" },
	evidenceDate: { type: "string" },
};

export type FindCompaniesOptions = {
	icpId: string;
	env: Env;
	freshnessDays?: number;
	scoreFloor?: number;
	maxRounds?: number;
};

export type FindCompaniesDeps = {
	recentDomains: (env: Env, icpId: string, days: number) => Promise<string[]>;
	synthesize: (
		icp: IcpDoc,
		feedback: readonly string[],
		env: Env,
	) => Promise<SynthesizeResult>;
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
	stage: "gate" | "judge";
};

export type FindCompaniesResult = {
	companies: CompanyRow[];
	requested: number;
	found: number;
	rounds: number;
	status: FindCompaniesStatus;
	costDollars: number;
	rejects: FindCompaniesReject[];
};

type CompanySummarySchema = {
	type: "object";
	description: string;
	properties: Record<string, { type: "string" }>;
	required: string[];
};

/** The JSON schema Exa fills per result. Only `name` and `domain` are required; every other field can come back null rather than invented. */
function companySummarySchema(systemPrompt: string): CompanySummarySchema {
	return {
		type: "object",
		description: systemPrompt,
		properties: SUMMARY_PROPERTIES,
		required: ["name", "domain"],
	};
}

function buildSearchRequest(
	query: string,
	systemPrompt: string,
	shape: SearchShape,
): ExaSearchRequest {
	return {
		query,
		numResults: RESULTS_PER_ROUND,
		...shape,
		contents: { summary: { schema: companySummarySchema(systemPrompt) } },
	};
}

type SummaryValue = NonNullable<ExaResult["summary"]>;

function isSummaryObject(
	value: ExaResult["summary"],
): value is { [key: string]: SummaryValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summaryField(
	summary: ExaResult["summary"],
	key: string,
): string | null {
	if (!isSummaryObject(summary)) return null;
	const value = summary[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toCompanyRow(result: ExaResult): CompanyRow {
	return {
		name: summaryField(result.summary, "name"),
		domain: summaryField(result.summary, "domain"),
		linkedinUrl: summaryField(result.summary, "linkedinUrl"),
		evidenceUrl: result.url,
		signal: summaryField(result.summary, "signal"),
		evidenceDate:
			result.publishedDate ??
			summaryField(result.summary, "evidenceDate") ??
			null,
	};
}

function toSearchResult(result: ExaResult): SearchResult {
	return {
		...(result.publishedDate !== undefined
			? { publishedDate: result.publishedDate }
			: {}),
	};
}

/**
 * Turns Exa's raw results into gate input: one `CompanyRow` per result plus
 * the vendor's own `publishedDate`, at the same index. `ExaResult` carries no
 * `score` yet, so the gate's score check stays inactive until it does.
 */
function toRowsAndResults(results: readonly ExaResult[]): {
	rows: CompanyRow[];
	results: SearchResult[];
} {
	return {
		rows: results.map(toCompanyRow),
		results: results.map(toSearchResult),
	};
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
	feedback: readonly string[];
	seenDomains: ReadonlySet<string>;
};

type RoundOutcome = {
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
	const synthesized = await deps.synthesize(ctx.icp, ctx.feedback, opts.env);
	const searchLedger = new CostLedger();
	const request = buildSearchRequest(
		synthesized.query,
		synthesized.systemPrompt,
		synthesized.searchShape,
	);
	const searched = await deps.search(request, opts.env, searchLedger);
	const { rows, results } = toRowsAndResults(searched.results);
	const unseenCount = countUnseen(rows, ctx.seenDomains);
	const gated = deps.gate(rows, results, {
		freshnessDays: opts.freshnessDays ?? DEFAULT_FRESHNESS_DAYS,
		seenDomains: ctx.seenDomains,
		scoreFloor: opts.scoreFloor ?? DEFAULT_SCORE_FLOOR,
		query: synthesized.query,
	});
	const judged =
		gated.kept.length > 0
			? await deps.judge(ctx.icp, gated.kept, opts.env)
			: { verdicts: [], ledger: new CostLedger() };
	return {
		rows,
		gateRejects: gated.rejects,
		keptRows: gated.kept,
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
};

async function runRounds(
	input: RunInput,
	opts: FindCompaniesOptions,
	deps: FindCompaniesDeps,
): Promise<RoundsAccumulator> {
	const companies: CompanyRow[] = [];
	const rejects: FindCompaniesReject[] = [];
	const ledgers: CostLedger[] = [];
	const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
	let feedback: string[] = [];
	let status: FindCompaniesStatus = "short";
	let rounds = 0;

	for (let round = 0; round < maxRounds; round++) {
		rounds += 1;
		const outcome = await runRound(
			{ icp: input.icp, feedback, seenDomains: input.seenDomains },
			opts,
			deps,
		);
		ledgers.push(outcome.ledger);
		for (const domain of collectDomains(outcome.rows))
			input.seenDomains.add(domain);

		const gateRejects = toGateRejects(outcome.rows, outcome.gateRejects);
		const { accepted, judgeRejects } = applyVerdicts(
			outcome.keptRows,
			outcome.verdicts,
		);
		const roundRejects = [...gateRejects, ...judgeRejects];
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
	return { companies, rejects, ledgers, rounds, status };
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
	};
}
