import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type {
	FindCompaniesReject,
	FindCompaniesResult,
	RetrievedPage,
} from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import {
	evidenceRowsFor,
	matchRow,
	rawResultEvidenceRow,
	retrievedPageEvidenceRow,
	roundRefusalsEvidenceRow,
	toNewCompany,
} from "@/core/companies/rows";
import {
	appendEvidence,
	recordRunSpend,
	saveCompanies,
	saveIcpRequirements,
	saveRound,
} from "@/core/db/queries";
import type { Company, NewCompany, NewEvidence } from "@/core/db/schema";
import type { Requirement } from "@/core/requirements";
import { readRequirements } from "@/core/requirements";
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
};

/** Banks what one round spent and what it did, in one durable step, so both land together or replay together: the round row, and a run-level evidence row naming every company the judge refused and why. */
export async function persistRound(input: PersistRoundInput): Promise<void> {
	const { step, env, runId, icpId, report } = input;
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
			const refusals = roundRefusalsEvidenceRow(
				icpId,
				runId,
				report.round,
				input.result.rejects,
			);
			if (refusals) await appendEvidence(env, [refusals]);
		},
	);
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

/**
 * The requirements this profile insists on. A profile onboarded before the
 * reader existed has none stored, so they are read once from its description
 * and written back onto the document, and every later run reads them from
 * there rather than paying again.
 */
export async function loadRequirements(
	env: Env,
	step: WorkflowStep,
	icpId: string,
	icp: IcpDoc,
): Promise<Requirement[]> {
	const stored = icp.requirements ?? [];
	if (stored.length > 0) return stored;
	const read = await step.do(
		"read-requirements",
		config.stepConfig.paidCall,
		async () => {
			const result = await readRequirements(icp.description, env);
			return {
				requirements: result.requirements,
				costDollars: result.ledger.total(),
			};
		},
	);
	return step.do("save-requirements", config.stepConfig.databaseCall, () =>
		saveIcpRequirements(env, icpId, read.requirements),
	);
}
