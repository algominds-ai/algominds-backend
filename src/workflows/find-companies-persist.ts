import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type {
	FindCompaniesDeps,
	FindCompaniesOptions,
	FindCompaniesReject,
	FindCompaniesResult,
	RetrievedPage,
} from "@/core/companies";
import { findCompanies } from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import {
	evidenceRowsFor,
	matchRow,
	type RoundTiming,
	rawResultEvidenceRow,
	retrievedPageEvidenceRow,
	roundRefusalsEvidenceRow,
	roundTimingsEvidenceRow,
	toNewCompany,
} from "@/core/companies/rows";
import { PartialSpendError, purchase } from "@/core/cost";
import {
	appendEvidence,
	recordRunSpend,
	saveCompanies,
	saveIcpProfile,
	saveRound,
} from "@/core/db/queries";
import type { Company, NewCompany, NewEvidence } from "@/core/db/schema";
import { writeSellerProfile } from "@/core/onboard";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";

/** One round refused seventy eight companies once. Enough of them to answer why, not all of them. */
const STORED_REJECTS_PER_ROUND = 120;

export type RoundReport = {
	round: number;
	angle: string;
	query: string;
	recency: string | null;
	eventWindowDays: number | null;
	recencyDays: number | null;
	source: string;
	agentEffort: string;
	found: number;
	rejected: { filter: number; gate: number; judge: number };
};

/** One line per round: the angle it tried, what it kept, and how many fell at each stage. The reasons themselves stay inside the run, since one round refused seventy eight companies and named every one. */
export function reportRound(
	round: number,
	result: FindCompaniesResult,
): RoundReport {
	const plan = result.searches[0];
	const count = (stage: FindCompaniesReject["stage"]): number =>
		result.rejects.filter((reject) => reject.stage === stage).length;
	return {
		round,
		angle: plan?.angle ?? "",
		query: plan?.query ?? "",
		recency: plan?.recency ?? null,
		eventWindowDays: plan?.eventWindowDays ?? null,
		recencyDays: plan?.recencyDays ?? null,
		source: plan?.source ?? "",
		agentEffort: plan?.agentEffort ?? "",
		found: result.companies.length,
		rejected: {
			filter: count("filter"),
			gate: count("gate"),
			judge: count("judge"),
		},
	};
}

/** The round's plan column: every angle the round searched, not only the first, so an agent round's other angles are not lost when it fans out to more than one. Null when the round produced no angle at all. */
export function roundPlan(
	searches: readonly SearchPlan[],
): SearchPlan[] | null {
	return searches.length > 0 ? [...searches] : null;
}

type PersistRoundInput = {
	step: WorkflowStep;
	env: Env;
	runId: string;
	icpId: string;
	costDollars: number;
	result: FindCompaniesResult;
	report: RoundReport;
	timings: readonly RoundTiming[];
};

/** Banks what one round spent and what it did, in one durable step, so both land together or replay together: the round row, and a run-level evidence row naming every company the judge refused and why. */
export async function persistRound(input: PersistRoundInput): Promise<void> {
	const { step, env, runId, report } = input;
	await step.do(
		`round_${report.round}-spend`,
		config.stepConfig.databaseCall,
		async () => {
			await recordRunSpend(env, runId, input.costDollars);
			await saveRound(env, {
				runId,
				ordinal: report.round,
				plan: roundPlan(input.result.searches),
				found: report.found,
				rejected: report.rejected,
				rejects: input.result.rejects.slice(0, STORED_REJECTS_PER_ROUND),
			});
			const rows = [
				roundRefusalsEvidenceRow(runId, report.round, input.result.rejects),
				roundTimingsEvidenceRow(runId, report.round, input.timings),
			].filter((row) => row !== null);
			if (rows.length > 0) await appendEvidence(env, rows);
		},
	);
}

type PersistRoundFailureInput = {
	step: WorkflowStep;
	env: Env;
	runId: string;
	round: number;
	costDollars: number;
};

/** Banks what a round had already spent before it threw, so a run that dies mid-round still shows the vendor spend it paid for. */
async function persistRoundFailureSpend(
	input: PersistRoundFailureInput,
): Promise<void> {
	const { step, env, runId, round, costDollars } = input;
	await step.do(
		`round_${round}-spend-errored`,
		config.stepConfig.databaseCall,
		() => recordRunSpend(env, runId, costDollars),
	);
}

export type RoundStepInput = {
	env: Env;
	step: WorkflowStep;
	runId: string;
	round: number;
	alreadySpent: number;
	icp: IcpDoc;
	remaining: number;
	opts: FindCompaniesOptions;
	deps: FindCompaniesDeps;
};

/** Runs the round's own search, and when it throws after it had already spent something, banks that spend before letting the original error through. */
export async function runRoundBody(
	input: RoundStepInput,
): Promise<FindCompaniesResult> {
	const { env, step, runId, round, alreadySpent, icp, remaining, opts, deps } =
		input;
	try {
		return await findCompanies(icp, remaining, opts, deps);
	} catch (error) {
		if (!(error instanceof PartialSpendError)) throw error;
		await persistRoundFailureSpend({
			step,
			env,
			runId,
			round,
			costDollars: alreadySpent + error.costDollars,
		});
		throw error.cause;
	}
}

type PersistCompaniesInput = {
	icpId: string;
	runId: string;
	organizationId: string;
	companies: readonly CompanyRow[];
	captures: Record<string, CompanyCapture>;
	pages: readonly RetrievedPage[];
};

function pagesByDomainOf(
	pages: readonly RetrievedPage[],
): Map<string, RetrievedPage[]> {
	const byDomain = new Map<string, RetrievedPage[]>();
	for (const page of pages) {
		const forDomain = byDomain.get(page.domain) ?? [];
		forDomain.push(page);
		byDomain.set(page.domain, forDomain);
	}
	return byDomain;
}

/** Every evidence row one saved company earns: its own judged fields, the vendor's raw result, and every page a round retrieved to prove it. */
function companyEvidenceRows(
	company: Company,
	companies: readonly CompanyRow[],
	captures: Record<string, CompanyCapture>,
	pagesByDomain: Map<string, RetrievedPage[]>,
): NewEvidence[] {
	const row = matchRow(companies, company);
	if (!row) return [];
	const rows = evidenceRowsFor(company, row);
	const capture = row.domain ? captures[row.domain] : undefined;
	if (capture) rows.push(rawResultEvidenceRow(company, capture));
	const pages = row.domain ? (pagesByDomain.get(row.domain) ?? []) : [];
	for (const page of pages) rows.push(retrievedPageEvidenceRow(company, page));
	return rows;
}

export async function persistCompanies(
	env: Env,
	input: PersistCompaniesInput,
): Promise<void> {
	const { icpId, runId, organizationId, companies, captures } = input;
	const pagesByDomain = pagesByDomainOf(input.pages);
	const newCompanies = companies
		.map((row) =>
			toNewCompany(
				row,
				{ icpId, runId, organizationId },
				row.domain ? captures[row.domain] : undefined,
			),
		)
		.filter((row): row is NewCompany => row !== null);
	const saved = await saveCompanies(env, newCompanies);
	const evidenceRows = saved.flatMap((company) =>
		companyEvidenceRows(company, companies, captures, pagesByDomain),
	);
	await appendEvidence(env, evidenceRows);
}

/** Extracts free-text requests once and banks their reported cost before proceeding. */
export async function extractProfile(input: {
	env: Env;
	step: WorkflowStep;
	icp: IcpDoc;
	icpId: string;
	runId: string;
	alreadySpent: number;
}): Promise<{ icp: IcpDoc; costDollars: number }> {
	const { env, step, icpId, runId, alreadySpent } = input;
	let icp = input.icp;
	let costDollars = alreadySpent;
	if (!icp.extracted) {
		const extracted = await step.do(
			"extract-profile",
			config.stepConfig.paidCall,
			() =>
				purchase(async () => {
					const result = await writeSellerProfile(
						env,
						icp.seller.domain,
						[],
						icp.instructions,
					);
					return {
						value: result.profile,
						costDollars: result.ledger.total(),
					};
				}),
		);
		costDollars += extracted.costDollars;
		await step.do("bank-extraction", config.stepConfig.databaseCall, () =>
			recordRunSpend(env, runId, costDollars),
		);
		if (extracted.error || !extracted.value)
			throw new NonRetryableError(
				`findCompanies: ${extracted.error ?? "profile extraction failed"}`,
			);
		const profile = extracted.value;
		icp = await step.do("save-profile", config.stepConfig.databaseCall, () =>
			saveIcpProfile(env, icpId, profile),
		);
	}
	return { icp, costDollars };
}
