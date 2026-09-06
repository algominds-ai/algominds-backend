import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";
import { appendEvidence } from "@/core/db/queries";
import type { Candidate } from "@/core/people/candidate";
import { dedupe } from "@/core/people/dedupe";
import { EMPTY_PROVIDER_HINTS, seniorRoster } from "@/core/people/roster";
import { rawEvidenceRow } from "@/core/people/rows";
import { exaPeopleRoster } from "@/core/providers/exa/people-roster";
import { getleadsDecisionMakers } from "@/core/providers/getleads";
import { RetryableProviderError } from "@/core/providers/waterfall";
import type {
	CompanyLoopContext,
	CompanyRunResult,
	IdentityStepResult,
	RosterStepResult,
} from "@/workflows/find-people-company";
import type { TargetCompany } from "@/workflows/find-people-target";

type FallbackRosterResult = {
	candidates: Candidate[];
	costEntries: CostEntry[];
};

export type FallbackTarget = {
	domain: string;
	name: string | null;
	organizationId: string | null;
};

async function exaRoster(
	ctx: CompanyLoopContext,
	runCompanyId: string,
	target: FallbackTarget,
): Promise<FallbackRosterResult> {
	if (target.organizationId === null) {
		return { candidates: [], costEntries: [] };
	}
	const ledger = new CostLedger();
	const result = await exaPeopleRoster(
		ctx.env,
		{ domain: target.domain, name: target.name },
		target.organizationId,
		ledger,
	).catch((error: unknown) => {
		if (error instanceof RetryableProviderError) throw error;
		return error instanceof Error ? error.message : String(error);
	});
	if (typeof result === "string") {
		await appendEvidence(ctx.env, [
			rawEvidenceRow(runCompanyId, "roster", "exa", { error: result }),
		]);
		return { candidates: [], costEntries: [] };
	}
	await appendEvidence(ctx.env, [
		rawEvidenceRow(runCompanyId, "roster", "exa", result.raw),
	]);
	return {
		candidates: dedupe(result.rows),
		costEntries: ledger.toJSON().entries,
	};
}

/** The GetLeads decision makers for `target.domain`, as candidates, with the raw reply kept as evidence; when GetLeads returns no rows, the Exa people index's senior people at the company, gated by `target.organizationId`; an empty list when both hold nobody, so a fallback never makes a company worse off. A GetLeads refusal is recorded and Exa is tried the same way. */
export async function fallbackRoster(
	ctx: CompanyLoopContext,
	runCompanyId: string,
	target: FallbackTarget,
): Promise<FallbackRosterResult> {
	const result = await getleadsDecisionMakers(ctx.env, target.domain).catch(
		(error: unknown) => {
			if (error instanceof RetryableProviderError) throw error;
			return error instanceof Error ? error.message : String(error);
		},
	);
	if (typeof result === "string") {
		await appendEvidence(ctx.env, [
			rawEvidenceRow(runCompanyId, "roster", "getleads", { error: result }),
		]);
		return exaRoster(ctx, runCompanyId, target);
	}
	await appendEvidence(ctx.env, [
		rawEvidenceRow(runCompanyId, "roster", "getleads", result.raw),
	]);
	if (result.rows.length > 0) {
		return { candidates: dedupe(result.rows), costEntries: [] };
	}
	return exaRoster(ctx, runCompanyId, target);
}

/** `candidates` unchanged and no spend, when Clay already found someone; otherwise `fallbackRoster` for `target`. */
export async function rosterOrFallback(
	ctx: CompanyLoopContext,
	candidates: Candidate[],
	runCompanyId: string,
	target: FallbackTarget,
): Promise<FallbackRosterResult> {
	if (candidates.length > 0) return { candidates, costEntries: [] };
	return fallbackRoster(ctx, runCompanyId, target);
}

export type RosterTarget = FallbackTarget & { identifier: string };

/** Clay's senior roster for `target`, falling to `rosterOrFallback` when Clay holds nobody, with Clay's raw replies kept as evidence and its cost merged into the returned ledger. */
export async function runRosterStep(
	ctx: CompanyLoopContext,
	target: RosterTarget,
	runCompanyId: string,
): Promise<FallbackRosterResult & { clayRecords: number }> {
	return ctx.step.do(
		`people-${target.domain}-roster`,
		config.stepConfig.paidCall,
		async () => {
			const ledger = new CostLedger();
			const result = await seniorRoster(
				target.identifier,
				ctx.providerHints ?? EMPTY_PROVIDER_HINTS,
				ctx.env,
				ledger,
			);
			await appendEvidence(
				ctx.env,
				result.raw.map((body) =>
					rawEvidenceRow(runCompanyId, "roster", "clay", body),
				),
			);
			const fallback = await rosterOrFallback(
				ctx,
				result.candidates,
				runCompanyId,
				target,
			);
			for (const entry of fallback.costEntries) {
				ledger.reported(entry.provider, entry.op, entry.dollars);
			}
			return {
				candidates: fallback.candidates,
				clayRecords: result.quotaUsed,
				costEntries: ledger.toJSON().entries,
			};
		},
	);
}

export type RescueRefs = {
	runCompanyId: string;
	organizationId: string | null;
};

/** A roster for a domain Clay could not resolve, from GetLeads by domain, its candidates empty when it holds nobody either. Its cost entries are returned either way, so a rescue that finds nobody still banks what it spent trying. */
export async function rescueUnresolved(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	refs: RescueRefs,
	identity: IdentityStepResult,
): Promise<RosterStepResult> {
	return ctx.step.do(
		`people-${company.domain}-rescue`,
		config.stepConfig.paidCall,
		async () => {
			const { candidates, costEntries } = await fallbackRoster(
				ctx,
				refs.runCompanyId,
				{
					domain: company.domain,
					name: company.name,
					organizationId: refs.organizationId,
				},
			);
			return { candidates, clayRecords: identity.clayRecords, costEntries };
		},
	);
}

export type FailureSpend = { spentSoFar: number; ledger: CostLedger };

/** Records a company whose steps threw as run evidence and reports it unresolved, so one company's failure never ends the run. `spend` carries what the company had already spent before it failed, so that spend still counts toward the run total. */
export async function skipFailedCompany(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	spend: FailureSpend,
	error: unknown,
): Promise<CompanyRunResult> {
	await ctx.step.do(
		`people-${company.domain}-failed`,
		config.stepConfig.databaseCall,
		() =>
			appendEvidence(ctx.env, [
				{
					subjectType: "run",
					subjectId: ctx.runId,
					kind: "company-error",
					source: "engine",
					value: JSON.stringify({
						domain: company.domain,
						message: error instanceof Error ? error.message : String(error),
					}),
				},
			]),
	);
	return {
		outcome: { verified: 0, roster: 0, unresolvedDomain: company.domain },
		costDollars: spend.spentSoFar + spend.ledger.total(),
	};
}
