import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import {
	addPartialSpend,
	CostLedger,
	type Purchase,
	purchase,
} from "@/core/cost";
import {
	appendEvidence,
	recordRunSpend,
	updateRunCompany,
	upsertPeople,
} from "@/core/db/queries";
import type { NewPerson } from "@/core/db/schema";
import type { Candidate } from "@/core/people/candidate";
import { rawEvidenceRow, toNewPerson } from "@/core/people/rows";
import type {
	CompanyLoopContext,
	CompanyProgress,
} from "@/workflows/find-people-company";

/** Checks a bounded admission allowance before starting new work. */
export function canPurchase(
	progress: CompanyProgress,
	allowance = 0.05,
): boolean {
	return (
		progress.spentSoFar + progress.ledger.total() + allowance <=
		config.spend.perRunDollars
	);
}

export async function recordPeopleEvidence(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	name: string,
	body: unknown,
): Promise<void> {
	await ctx.step.do(
		`people-${progress.company.domain}-${name}-evidence`,
		config.stepConfig.databaseCall,
		() =>
			appendEvidence(ctx.env, [
				rawEvidenceRow(progress.runCompanyId, name, "engine", body),
			]),
	);
}

/** Banks a purchase's spend and raw outcome before exposing its error, so durable replay cannot repeat a partially billed call. */
export async function buyPeopleStep<T extends Rpc.Serializable<T>>(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	name: string,
	buy: (ledger: CostLedger) => Promise<T>,
): Promise<T> {
	if (!canPurchase(progress)) {
		progress.capped = true;
		throw new NonRetryableError("People run reached its spend allowance");
	}
	const result = await ctx.step.do<Purchase<T>>(
		`people-${progress.company.domain}-${name}`,
		config.stepConfig.paidCall,
		() =>
			purchase(async () => {
				const ledger = new CostLedger();
				try {
					return { value: await buy(ledger), costDollars: ledger.total() };
				} catch (error) {
					throw addPartialSpend(error, ledger.total());
				}
			}),
	);
	return bankPeoplePurchase(ctx, progress, name, result);
}

/** Banks a durable purchase independently so callers can retain a known external operation before a database failure. */
export async function bankPeoplePurchase<T>(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	name: string,
	result: Purchase<T>,
): Promise<T> {
	progress.ledger.reported("people", name, result.costDollars);
	await ctx.step.do(
		`people-${progress.company.domain}-${name}-bank`,
		config.stepConfig.databaseCall,
		async () => {
			await recordRunSpend(
				ctx.env,
				ctx.runId,
				progress.spentSoFar + progress.ledger.total(),
			);
			await appendEvidence(ctx.env, [
				rawEvidenceRow(progress.runCompanyId, name, "engine", result),
			]);
		},
	);
	if (result.error || result.value === null)
		throw new NonRetryableError(
			result.error ?? "People purchase returned no result",
		);
	return result.value;
}

/** Saves roster entries without granting verified status or overwriting previously verified data. */
export async function saveRosterPeople(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	candidates: readonly Candidate[],
): Promise<number> {
	return ctx.step.do(
		`people-${progress.company.domain}-save-roster`,
		config.stepConfig.databaseCall,
		async () => {
			const rows = candidates
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
			return (await upsertPeople(ctx.env, rows)).length;
		},
	);
}

/** Writes completeness and final company costs using the existing company outcome and append-only evidence. */
export async function finishPeopleCompany(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
): Promise<void> {
	await ctx.step.do(
		`people-${progress.company.domain}-finish`,
		config.stepConfig.databaseCall,
		async () => {
			await updateRunCompany(ctx.env, progress.runCompanyId, {
				peopleVerified: progress.verified,
				peopleRoster: progress.roster,
				clayRecords: progress.clayRecords,
				spendDollars: progress.ledger.total(),
				identity: progress.unresolved
					? "unresolved"
					: progress.company.linkedinUrl
						? "linkedin"
						: "domain",
			});
			await appendEvidence(ctx.env, [
				rawEvidenceRow(progress.runCompanyId, "completeness", "engine", {
					discovered: progress.discovered,
					eligible: progress.eligible,
					researched: progress.researched,
					checked: progress.checked,
					verified: progress.verified,
					capped: progress.capped,
					unprocessed: Math.max(0, progress.eligible - progress.checked),
					billingUnknown: progress.billingUnknown,
				}),
			]);
			await recordRunSpend(
				ctx.env,
				ctx.runId,
				progress.spentSoFar + progress.ledger.total(),
			);
		},
	);
}
