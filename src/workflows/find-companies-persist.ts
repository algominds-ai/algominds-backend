import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { RetrievedPage } from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import {
	evidenceRowsFor,
	matchRow,
	rawResultEvidenceRow,
	retrievedPageEvidenceRow,
	toNewCompany,
} from "@/core/companies/rows";
import {
	appendEvidence,
	saveCompanies,
	saveIcpRequirements,
} from "@/core/db/queries";
import type { NewCompany } from "@/core/db/schema";
import type { Requirement } from "@/core/requirements";
import { readRequirements } from "@/core/requirements";
import type { IcpDoc } from "@/core/synthesize";

type PersistCompaniesInput = {
	icpId: string;
	runId: string;
	organizationId: string;
	companies: readonly CompanyRow[];
	captures: Record<string, CompanyCapture>;
	pages: readonly RetrievedPage[];
};

export async function persistCompanies(
	env: Env,
	input: PersistCompaniesInput,
): Promise<void> {
	const { icpId, runId, organizationId, companies, captures } = input;
	const pagesByDomain = new Map(input.pages.map((page) => [page.domain, page]));
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
	const evidenceRows = saved.flatMap((company) => {
		const row = matchRow(companies, company);
		if (!row) return [];
		const rows = evidenceRowsFor(company, row);
		const capture = row.domain ? captures[row.domain] : undefined;
		if (capture) rows.push(rawResultEvidenceRow(company, capture));
		const page = row.domain ? pagesByDomain.get(row.domain) : undefined;
		if (page) rows.push(retrievedPageEvidenceRow(company, page));
		return rows;
	});
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
