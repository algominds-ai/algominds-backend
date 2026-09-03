import type { WorkflowStep } from "cloudflare:workers";
import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";
import {
	appendEvidence,
	createCompanyRow,
	recordRunSpend,
	saveRunCompanies,
	updateRunCompany,
	upsertPeople,
} from "@/core/db/queries";
import type { NewPerson } from "@/core/db/schema";
import type { ResolvedBuyer } from "@/core/people/buyer";
import type { Candidate } from "@/core/people/candidate";
import { resolveIdentity } from "@/core/people/identity";
import { seniorRoster } from "@/core/people/roster";
import { rawEvidenceRow, toNewPerson } from "@/core/people/rows";
import type { IcpDoc } from "@/core/synthesize";
import { applyCostEntries } from "@/workflows/agent-poll";
import type { TargetCompany } from "@/workflows/find-people-target";
import { runBuyerMode } from "@/workflows/find-people-verify";

export type CompanyLoopContext = {
	env: Env;
	step: WorkflowStep;
	runId: string;
	organizationId: string;
	buyer: ResolvedBuyer;
	profile: IcpDoc | null;
};

export type CompanyProgress = {
	domain: string;
	companyId: string;
	companyName: string;
	runCompanyId: string;
	spentSoFar: number;
	clayRecords: number;
	ledger: CostLedger;
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

type IdentityStepResult =
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

async function runRosterStep(
	ctx: CompanyLoopContext,
	domain: string,
	identifier: string,
	runCompanyId: string,
): Promise<{
	candidates: Candidate[];
	clayRecords: number;
	costEntries: CostEntry[];
}> {
	return ctx.step.do(
		`people-${domain}-roster`,
		config.stepConfig.paidCall,
		async () => {
			const ledger = new CostLedger();
			const result = await seniorRoster(identifier, ctx.buyer, ctx.env, ledger);
			await appendEvidence(
				ctx.env,
				result.raw.map((body) =>
					rawEvidenceRow(runCompanyId, "roster", "clay", body),
				),
			);
			return {
				candidates: result.candidates,
				clayRecords: result.quotaUsed,
				costEntries: ledger.toJSON().entries,
			};
		},
	);
}

export async function recordCompanySpend(
	ctx: CompanyLoopContext,
	progress: Pick<CompanyProgress, "domain" | "spentSoFar" | "ledger">,
): Promise<number> {
	const result = await ctx.step.do(
		`people-${progress.domain}-spend`,
		config.stepConfig.databaseCall,
		async () => {
			const total = progress.spentSoFar + progress.ledger.total();
			await recordRunSpend(ctx.env, ctx.runId, total);
			return { total };
		},
	);
	return result.total;
}

async function saveRosterPeople(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	roster: RosterStepResult,
): Promise<number> {
	const result = await ctx.step.do(
		`people-${progress.domain}-save`,
		config.stepConfig.databaseCall,
		async () => {
			const rows = roster.candidates
				.map((candidate) =>
					toNewPerson(
						candidate,
						{
							companyId: progress.companyId,
							organizationId: ctx.organizationId,
						},
						"roster",
						null,
					),
				)
				.filter((row): row is NewPerson => row !== null);
			const stored = await upsertPeople(ctx.env, rows);
			await updateRunCompany(ctx.env, progress.runCompanyId, {
				peopleRoster: stored.length,
				clayRecords: progress.clayRecords,
				spendDollars: progress.ledger.total(),
			});
			return { count: stored.length };
		},
	);
	return result.count;
}

async function finishRosterMode(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	roster: RosterStepResult,
): Promise<CompanyRunResult> {
	const rosterCount = await saveRosterPeople(ctx, progress, roster);
	const costDollars = await recordCompanySpend(ctx, progress);
	return {
		outcome: { verified: 0, roster: rosterCount, unresolvedDomain: null },
		costDollars,
	};
}

/** Runs the measured method for one requested domain: identity, company row, roster, then a roster save or the full buyer pipeline, depending on `ctx.buyer.mode`. */
export async function runOneCompany(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	spentSoFar: number,
): Promise<CompanyRunResult> {
	const runCompanyId = await openCompanyRow(ctx, company);
	const ledger = new CostLedger();
	const identity = await runIdentityStep(ctx, company, runCompanyId);
	applyCostEntries(identity.costEntries, ledger);
	if (identity.how === "unresolved") {
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
	const companyId = await ensureCompanyRow(
		ctx,
		company,
		runCompanyId,
		identity,
	);
	const roster = await runRosterStep(
		ctx,
		company.domain,
		identity.identifier,
		runCompanyId,
	);
	applyCostEntries(roster.costEntries, ledger);
	const progress: CompanyProgress = {
		domain: company.domain,
		companyId,
		companyName: identity.name ?? company.name ?? company.domain,
		runCompanyId,
		spentSoFar,
		clayRecords: identity.clayRecords + roster.clayRecords,
		ledger,
	};
	if (ctx.buyer.mode === "roster") {
		return finishRosterMode(ctx, progress, roster);
	}
	return runBuyerMode(ctx, progress, roster);
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
