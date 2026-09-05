import { config } from "@/config";
import {
	recordRunSpend,
	updateRunCompany,
	upsertPeople,
} from "@/core/db/queries";
import type { NewPerson } from "@/core/db/schema";
import { toNewPerson } from "@/core/people/rows";
import type {
	CompanyLoopContext,
	CompanyProgress,
	CompanyRunResult,
	RosterStepResult,
} from "@/workflows/find-people-company";

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

/** Saves a roster mode company's candidates as roster-only people, then records the run's total spend. */
export async function finishRosterMode(
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
