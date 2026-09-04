import { config } from "@/config";
import { appendEvidence } from "@/core/db/queries";
import type { Candidate } from "@/core/people/candidate";
import { dedupe } from "@/core/people/dedupe";
import { rawEvidenceRow } from "@/core/people/rows";
import { getleadsDecisionMakers } from "@/core/providers/getleads";
import { RetryableProviderError } from "@/core/providers/waterfall";
import type {
	CompanyLoopContext,
	CompanyRunResult,
	IdentityStepResult,
	RosterStepResult,
} from "@/workflows/find-people-company";
import type { TargetCompany } from "@/workflows/find-people-target";

/** The GetLeads decision makers for `domain`, as candidates, with the raw reply kept as evidence; an empty list when it holds nobody or refuses the request, so a fallback never makes a company worse off. */
export async function fallbackRoster(
	ctx: CompanyLoopContext,
	domain: string,
	runCompanyId: string,
): Promise<Candidate[]> {
	const result = await getleadsDecisionMakers(ctx.env, domain).catch(
		(error: unknown) => {
			if (error instanceof RetryableProviderError) throw error;
			return error instanceof Error ? error.message : String(error);
		},
	);
	if (typeof result === "string") {
		await appendEvidence(ctx.env, [
			rawEvidenceRow(runCompanyId, "roster", "getleads", { error: result }),
		]);
		return [];
	}
	await appendEvidence(ctx.env, [
		rawEvidenceRow(runCompanyId, "roster", "getleads", result.raw),
	]);
	return dedupe(result.rows);
}

/** A roster for a domain Clay could not resolve, from GetLeads by domain, or null when it holds nobody either. */
export async function rescueUnresolved(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	runCompanyId: string,
	identity: IdentityStepResult,
): Promise<RosterStepResult | null> {
	return ctx.step.do(
		`people-${company.domain}-rescue`,
		config.stepConfig.paidCall,
		async () => {
			const candidates = await fallbackRoster(
				ctx,
				company.domain,
				runCompanyId,
			);
			if (candidates.length === 0) return null;
			return { candidates, clayRecords: identity.clayRecords, costEntries: [] };
		},
	);
}

/** Records a company whose steps threw as run evidence and reports it unresolved, so one company's failure never ends the run. */
export async function skipFailedCompany(
	ctx: CompanyLoopContext,
	company: TargetCompany,
	spentSoFar: number,
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
		costDollars: spentSoFar,
	};
}
