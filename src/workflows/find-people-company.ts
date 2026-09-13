import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import { CostLedger } from "@/core/cost";
import {
	createCompanyRow,
	saveRunCompanies,
	updateRunCompany,
} from "@/core/db/queries";
import type { ResolvedBuyer } from "@/core/people/buyer";
import { exaOrganizationId } from "@/core/providers/exa/people-roster";
import { collectCompanyRoster } from "@/workflows/find-people-roster";
import {
	buyPeopleStep,
	finishPeopleCompany,
	recordPeopleEvidence,
	saveRosterPeople,
} from "@/workflows/find-people-spend";
import type { TargetCompany } from "@/workflows/find-people-target";
import { runBuyerMode } from "@/workflows/find-people-verify";

export type CompanyLoopContext = {
	env: Env;
	step: WorkflowStep;
	runId: string;
	organizationId: string;
	buyer: ResolvedBuyer;
};
export type CompanyProgress = {
	company: TargetCompany;
	companyId: string;
	runCompanyId: string;
	spentSoFar: number;
	ledger: CostLedger;
	clayRecords: number;
	discovered: number;
	eligible: number;
	researched: number;
	checked: number;
	verified: number;
	roster: number;
	capped: boolean;
	billingUnknown: boolean;
	unresolved: boolean;
	contextResolved: boolean;
};
export type CompanyRunResult = {
	outcome: {
		verified: number;
		roster: number;
		unresolvedDomain: string | null;
		capped: boolean;
	};
	costDollars: number;
};

async function openCompany(
	ctx: CompanyLoopContext,
	company: TargetCompany,
): Promise<string> {
	return ctx.step.do(
		`people-${company.domain}-open`,
		config.stepConfig.databaseCall,
		async () => {
			const [row] = await saveRunCompanies(ctx.env, [
				{
					runId: ctx.runId,
					domain: company.domain,
					companyId: company.id,
					identity: null,
					mode: ctx.buyer.mode,
					buyerSource: ctx.buyer.buyerSource,
				},
			]);
			if (!row) throw new Error(`Cannot open company ${company.domain}`);
			return row.id;
		},
	);
}

async function ensureCompany(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
): Promise<void> {
	progress.companyId = await ctx.step.do(
		`people-${progress.company.domain}-create-company`,
		config.stepConfig.databaseCall,
		async () => {
			const company = progress.company;
			const row = company.id
				? { id: company.id }
				: await createCompanyRow(ctx.env, {
						organizationId: ctx.organizationId,
						domain: company.domain,
						name: company.name ?? company.domain,
						linkedinUrl: company.linkedinUrl,
						description: company.description,
						icpId: company.icpId,
						runId: ctx.runId,
					});
			await updateRunCompany(ctx.env, progress.runCompanyId, {
				companyId: row.id,
				identity: company.linkedinUrl ? "linkedin" : "domain",
			});
			return row.id;
		},
	);
}

/** Fills missing bare-domain context once, retaining stored company fields when available. */
export async function resolveCompanyContext(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
): Promise<void> {
	if (progress.contextResolved) return;
	const lookup = await buyPeopleStep(
		ctx,
		progress,
		"company-context",
		(ledger) => exaOrganizationId(ctx.env, progress.company.domain, ledger),
	);
	progress.contextResolved = true;
	progress.company = {
		...progress.company,
		exaId: progress.company.exaId ?? lookup.organizationId,
		name: progress.company.name ?? lookup.name,
		description: progress.company.description ?? lookup.description,
		workforceTotal: progress.company.workforceTotal ?? lookup.workforceTotal,
	};
}

async function searchCompany(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
): Promise<void> {
	if (!progress.company.name) await resolveCompanyContext(ctx, progress);
	const candidates = await collectCompanyRoster(ctx, progress);
	progress.discovered = candidates.length;
	progress.unresolved = !progress.company.name && candidates.length === 0;
	if (progress.unresolved) return;
	await ensureCompany(ctx, progress);
	if (ctx.buyer.mode === "roster")
		progress.roster = await saveRosterPeople(ctx, progress, candidates);
	else await runBuyerMode(ctx, progress, candidates);
}

/** Processes one company's complete eligible roster, banking partial purchases and exposing all truncated work. */
export async function runOneCompany(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	spentSoFar: number,
): Promise<CompanyRunResult> {
	const progress: CompanyProgress = {
		company,
		companyId: company.id ?? "",
		runCompanyId: await openCompany(ctx, company),
		spentSoFar,
		ledger: new CostLedger(),
		clayRecords: 0,
		discovered: 0,
		eligible: 0,
		researched: 0,
		checked: 0,
		verified: 0,
		roster: 0,
		capped: false,
		billingUnknown: false,
		unresolved: false,
		contextResolved: false,
	};
	try {
		await searchCompany(ctx, progress);
	} catch (error) {
		progress.capped = true;
		await recordPeopleEvidence(ctx, progress, "company-error", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
	await finishPeopleCompany(ctx, progress);
	if (progress.billingUnknown)
		throw new NonRetryableError(
			"People research billing remains unknown; reservation evidence retained",
		);
	return {
		outcome: {
			verified: progress.verified,
			roster: progress.roster,
			unresolvedDomain: progress.unresolved ? company.domain : null,
			capped: progress.capped,
		},
		costDollars: spentSoFar + progress.ledger.total(),
	};
}

export type PeopleLoopResult = {
	companiesSearched: number;
	peopleVerified: number;
	peopleRoster: number;
	costDollars: number;
	unknownDomains: string[];
	capped: boolean;
};

/** Runs companies sequentially so every cumulative spend write includes all preceding purchases. */
export async function runCompanies(
	ctx: CompanyLoopContext,
	companies: readonly TargetCompany[],
	alreadySpent: number,
): Promise<PeopleLoopResult> {
	const result: PeopleLoopResult = {
		companiesSearched: 0,
		peopleVerified: 0,
		peopleRoster: 0,
		costDollars: alreadySpent,
		unknownDomains: [],
		capped: false,
	};
	for (const company of companies) {
		if (result.costDollars + 0.05 > config.spend.perRunDollars) {
			result.capped = true;
			break;
		}
		const completed = await runOneCompany(ctx, company, result.costDollars);
		result.companiesSearched++;
		result.peopleVerified += completed.outcome.verified;
		result.peopleRoster += completed.outcome.roster;
		result.costDollars = completed.costDollars;
		result.capped ||= completed.outcome.capped;
		if (completed.outcome.unresolvedDomain)
			result.unknownDomains.push(completed.outcome.unresolvedDomain);
	}
	return result;
}
