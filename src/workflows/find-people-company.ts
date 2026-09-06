import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";
import {
	appendEvidence,
	createCompanyRow,
	saveRunCompanies,
	updateRunCompany,
} from "@/core/db/queries";
import type { IcpDoc } from "@/core/icp";
import type { ResolvedBuyer } from "@/core/people/buyer";
import { resolveIdentity } from "@/core/people/identity";
import type { PeopleProviderHints } from "@/core/people/roster";
import { rawEvidenceRow } from "@/core/people/rows";
import { exaOrganizationId } from "@/core/providers/exa/people-roster";
import { RetryableProviderError } from "@/core/providers/waterfall";
import { applyCostEntries } from "@/workflows/agent-poll";
import {
	rescueUnresolved,
	runRosterStep,
	skipFailedCompany,
} from "@/workflows/find-people-rescue";
import {
	finishRosterMode,
	recordCompanySpend,
} from "@/workflows/find-people-spend";
import type { TargetCompany } from "@/workflows/find-people-target";
import { runBuyerMode } from "@/workflows/find-people-verify";

export type CompanyLoopContext = {
	env: Env;
	step: WorkflowStep;
	runId: string;
	organizationId: string;
	buyer: ResolvedBuyer;
	profile: IcpDoc | null;
	providerHints?: PeopleProviderHints;
};

export type CompanyProgress = {
	domain: string;
	companyId: string;
	companyName: string;
	runCompanyId: string;
	spentSoFar: number;
	clayRecords: number;
	ledger: CostLedger;
	exaOrganizationId: string | null;
	workforceTotal: number | null;
};

export type CompanyOutcome = {
	verified: number;
	roster: number;
	unresolvedDomain: string | null;
};

export type CompanyRunResult = {
	outcome: CompanyOutcome;
	costDollars: number;
};

export type RosterStepResult = Awaited<ReturnType<typeof runRosterStep>>;

type ResolvedIdentity = { how: "domain" | "linkedin"; identifier: string };

async function openCompanyRow(
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
			if (!row) {
				throw new Error(
					`findPeople: failed to open run_company for ${company.domain}`,
				);
			}
			return row.id;
		},
	);
}

export type IdentityStepResult =
	| {
			how: "domain" | "linkedin";
			identifier: string;
			name: string | null;
			clayRecords: number;
			costEntries: CostEntry[];
	  }
	| {
			how: "unresolved";
			clayRecords: number;
			costEntries: CostEntry[];
	  };

async function runIdentityStep(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	runCompanyId: string,
): Promise<IdentityStepResult> {
	return ctx.step.do(
		`people-${company.domain}-identity`,
		config.stepConfig.paidCall,
		async (): Promise<IdentityStepResult> => {
			const ledger = new CostLedger();
			const result = await resolveIdentity(
				{ domain: company.domain, linkedinUrl: company.linkedinUrl },
				ctx.env,
				ledger,
			);
			await appendEvidence(
				ctx.env,
				result.raw.map((body) =>
					rawEvidenceRow(runCompanyId, "identity", "clay", body),
				),
			);
			const costEntries = ledger.toJSON().entries;
			if (result.how === "unresolved") {
				return {
					how: "unresolved",
					clayRecords: result.quotaUsed,
					costEntries,
				};
			}
			return {
				how: result.how,
				identifier: result.identifier,
				name: result.name,
				clayRecords: result.quotaUsed,
				costEntries,
			};
		},
	);
}

async function markUnresolved(
	ctx: CompanyLoopContext,
	domain: string,
	runCompanyId: string,
	spend: { clayRecords: number; spendDollars: number },
): Promise<void> {
	await ctx.step.do(
		`people-${domain}-unresolved`,
		config.stepConfig.databaseCall,
		() =>
			updateRunCompany(ctx.env, runCompanyId, {
				identity: "unresolved",
				clayRecords: spend.clayRecords,
				spendDollars: spend.spendDollars,
			}),
	);
}

/** The Exa organization id and headcount for `domain`, resolved once per company so both the roster fallback and the verify second opinion can compare against the id by id rather than by name, and the buyer selector can read the headcount. A miss, or any non-retryable failure, is `null` for both fields. */
async function runOrganizationStep(
	ctx: CompanyLoopContext,
	domain: string,
): Promise<{
	organizationId: string | null;
	workforceTotal: number | null;
	costEntries: CostEntry[];
}> {
	return ctx.step.do(
		`people-${domain}-organization`,
		config.stepConfig.paidCall,
		async () => {
			const ledger = new CostLedger();
			const lookup = await exaOrganizationId(ctx.env, domain, ledger).catch(
				(error: unknown) => {
					if (error instanceof RetryableProviderError) throw error;
					return { organizationId: null, workforceTotal: null };
				},
			);
			return { ...lookup, costEntries: ledger.toJSON().entries };
		},
	);
}

async function ensureCompanyRow(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	runCompanyId: string,
	identity: ResolvedIdentity & { name: string | null },
): Promise<string> {
	return ctx.step.do(
		`people-${company.domain}-create-company`,
		config.stepConfig.databaseCall,
		async () => {
			if (company.id === null) {
				const created = await createCompanyRow(ctx.env, {
					organizationId: ctx.organizationId,
					domain: company.domain,
					name: identity.name ?? company.domain,
					icpId: company.icpId,
					runId: ctx.runId,
				});
				await updateRunCompany(ctx.env, runCompanyId, {
					companyId: created.id,
					identity: identity.how,
				});
				return created.id;
			}
			await updateRunCompany(ctx.env, runCompanyId, { identity: identity.how });
			return company.id;
		},
	);
}

function rescuedEmpty(rescued: RosterStepResult | null): boolean {
	return rescued === null || rescued.candidates.length === 0;
}

/** The company's headcount for the buyer selector: the stored company row's own record, else the Exa organization lookup run for the same company. */
function resolvedWorkforceTotal(
	company: TargetCompany,
	organization: { workforceTotal: number | null },
): number | null {
	return company.workforceTotal ?? organization.workforceTotal;
}

type UnresolvedOutcome = {
	company: TargetCompany;
	runCompanyId: string;
	spentSoFar: number;
	identity: IdentityStepResult;
	ledger: CostLedger;
};

async function markCompanyUnresolved(
	ctx: CompanyLoopContext,
	unresolved: UnresolvedOutcome,
): Promise<CompanyRunResult> {
	const { company, runCompanyId, spentSoFar, identity, ledger } = unresolved;
	await markUnresolved(ctx, company.domain, runCompanyId, {
		clayRecords: identity.clayRecords,
		spendDollars: ledger.total(),
	});
	const costDollars = await recordCompanySpend(ctx, {
		domain: company.domain,
		spentSoFar,
		ledger,
	});
	return {
		outcome: { verified: 0, roster: 0, unresolvedDomain: company.domain },
		costDollars,
	};
}

/**
 * Runs the measured method for one requested domain: identity, company row,
 * roster, then a roster save or the full buyer pipeline, depending on
 * `ctx.buyer.mode`. Keeps its spend ledger reachable on the way out, so a step
 * that throws midway still banks what it had already spent, through
 * `skipFailedCompany`.
 */
export async function runOneCompany(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	spentSoFar: number,
): Promise<CompanyRunResult> {
	const ledger = new CostLedger();
	try {
		const runCompanyId = await openCompanyRow(ctx, company);
		const identity = await runIdentityStep(ctx, company, runCompanyId);
		applyCostEntries(identity.costEntries, ledger);
		const organization = await runOrganizationStep(ctx, company.domain);
		applyCostEntries(organization.costEntries, ledger);
		const rescued =
			identity.how === "unresolved"
				? await rescueUnresolved(
						ctx,
						company,
						{ runCompanyId, organizationId: organization.organizationId },
						identity,
					)
				: null;
		if (identity.how === "unresolved" && rescuedEmpty(rescued)) {
			if (rescued) applyCostEntries(rescued.costEntries, ledger);
			return await markCompanyUnresolved(ctx, {
				company,
				runCompanyId,
				spentSoFar,
				identity,
				ledger,
			});
		}
		const resolved =
			identity.how === "unresolved"
				? {
						how: "domain" as const,
						identifier: company.domain,
						name: company.name,
					}
				: identity;
		const companyId = await ensureCompanyRow(
			ctx,
			company,
			runCompanyId,
			resolved,
		);
		const roster =
			rescued ??
			(await runRosterStep(
				ctx,
				{
					domain: company.domain,
					identifier: resolved.identifier,
					name: resolved.name,
					organizationId: organization.organizationId,
				},
				runCompanyId,
			));
		applyCostEntries(roster.costEntries, ledger);
		const progress: CompanyProgress = {
			domain: company.domain,
			companyId,
			companyName: resolved.name ?? company.name ?? company.domain,
			runCompanyId,
			spentSoFar,
			clayRecords: identity.clayRecords + roster.clayRecords,
			ledger,
			exaOrganizationId: organization.organizationId,
			workforceTotal: resolvedWorkforceTotal(company, organization),
		};
		if (ctx.buyer.mode === "roster") {
			return await finishRosterMode(ctx, progress, roster);
		}
		return await runBuyerMode(ctx, progress, roster);
	} catch (error) {
		return skipFailedCompany(ctx, company, { spentSoFar, ledger }, error);
	}
}

export type PeopleLoopResult = {
	companiesSearched: number;
	peopleVerified: number;
	peopleRoster: number;
	costDollars: number;
	unknownDomains: string[];
	capped: boolean;
};

/**
 * Runs the clamped companies in `people.companyConcurrency`-sized batches,
 * each batch run with `Promise.all`, checking the per-run spend ceiling once
 * before every batch. A batch already started always finishes, so overshoot
 * past the ceiling is bounded by at most one batch of companies.
 */
export async function runCompanies(
	ctx: CompanyLoopContext,
	companies: readonly TargetCompany[],
	alreadySpent: number,
): Promise<PeopleLoopResult> {
	let costDollars = alreadySpent;
	let peopleVerified = 0;
	let peopleRoster = 0;
	let companiesSearched = 0;
	const unknownDomains: string[] = [];
	let capped = false;
	const batchSize = config.people.companyConcurrency;
	for (let start = 0; start < companies.length; start += batchSize) {
		if (costDollars >= config.spend.perRunDollars) {
			capped = true;
			break;
		}
		const batchStart = costDollars;
		const batch = companies.slice(start, start + batchSize);
		const results = await Promise.all(
			batch.map((company) => runOneCompany(ctx, company, batchStart)),
		);
		for (const result of results) {
			companiesSearched += 1;
			peopleVerified += result.outcome.verified;
			peopleRoster += result.outcome.roster;
			if (result.outcome.unresolvedDomain !== null) {
				unknownDomains.push(result.outcome.unresolvedDomain);
			}
			costDollars += result.costDollars - batchStart;
		}
	}
	return {
		companiesSearched,
		peopleVerified,
		peopleRoster,
		costDollars,
		unknownDomains,
		capped,
	};
}
