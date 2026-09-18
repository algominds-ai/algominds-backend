import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import { CostLedger, purchase } from "@/core/cost";
import { appendEvidence, recordRunSpend } from "@/core/db/queries";
import type { Candidate } from "@/core/people/candidate";
import {
	MEDIUM_AGENT_DOLLARS,
	ResearchOutputSchema,
	researchRequest,
	researchSubjects,
} from "@/core/people/research";
import { rawEvidenceRow } from "@/core/people/rows";
import {
	cancelAgentRun,
	getAgentRunOutput,
	startAgentRun,
} from "@/core/providers/exa/agent";
import type {
	CompanyLoopContext,
	CompanyProgress,
} from "@/workflows/find-people-company";
import {
	bankPeoplePurchase,
	canPurchase,
	recordPeopleEvidence,
} from "@/workflows/find-people-spend";

async function unknownBilling(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	name: string,
	id: string | null,
): Promise<void> {
	progress.billingUnknown = true;
	progress.capped = true;
	await recordPeopleEvidence(ctx, progress, `${name}-billing-unknown`, {
		id,
		reportedCostDollars: null,
		reservedDollars: MEDIUM_AGENT_DOLLARS,
		billingUnknown: true,
	});
}

type ActiveBatch = { id: string; name: string; billed: number };

/** Cancels timed-out work and durably settles its reported fee before returning any failure. */
async function settleBatch(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	batch: ActiveBatch,
): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const result = await ctx.step.do(
			`people-${progress.company.domain}-${batch.name}-settle-${attempt}`,
			config.stepConfig.paidCall,
			() =>
				purchase(async () => ({
					value: await cancelAgentRun(batch.id, ctx.env, attempt === 0),
					costDollars: 0,
				})),
		);
		const cost = result.value?.costDollars;
		if (cost !== null && cost !== undefined && cost > batch.billed) {
			progress.ledger.reported("exa", "agent", cost - batch.billed);
			batch.billed = cost;
		}
		await ctx.step.do(
			`people-${progress.company.domain}-${batch.name}-settle-bank-${attempt}`,
			config.stepConfig.databaseCall,
			async () => {
				await recordRunSpend(
					ctx.env,
					ctx.runId,
					progress.spentSoFar + progress.ledger.total(),
				);
				await appendEvidence(ctx.env, [
					rawEvidenceRow(
						progress.runCompanyId,
						"research-settlement",
						"exa",
						result,
					),
				]);
			},
		);
		if (result.value?.terminal && result.value.costDollars !== null) return;
		if (attempt < 2)
			await ctx.step.sleep(
				`people-${progress.company.domain}-${batch.name}-settle-wait-${attempt}`,
				"5 seconds",
			);
	}
	await unknownBilling(ctx, progress, batch.name, batch.id);
}

async function readBatch(ctx: CompanyLoopContext, id: string) {
	const ledger = new CostLedger();
	try {
		const value = await getAgentRunOutput(
			id,
			ctx.env,
			ledger,
			ResearchOutputSchema,
		);
		return { value, costDollars: ledger.total(), error: null };
	} catch (error) {
		if (!(error instanceof NonRetryableError)) throw error;
		return { value: null, costDollars: ledger.total(), error: error.message };
	}
}

async function pollBatch(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	batch: ActiveBatch,
) {
	for (
		let attempt = 0;
		attempt < config.people.exaAgentMaxPollAttempts;
		attempt++
	) {
		if (!canPurchase(progress)) {
			progress.capped = true;
			throw new NonRetryableError("People run reached its spend allowance");
		}
		const name = `${batch.name}-poll-${attempt}`;
		const polled = await ctx.step.do(
			`people-${progress.company.domain}-${name}`,
			config.stepConfig.paidCall,
			() => readBatch(ctx, batch.id),
		);
		const result = await bankPeoplePurchase(ctx, progress, name, polled);
		if (result.status === "completed") return result.output;
		if (attempt + 1 < config.people.exaAgentMaxPollAttempts)
			await ctx.step.sleep(
				`people-${progress.company.domain}-${batch.name}-wait-${attempt}`,
				`${config.people.exaAgentPollIntervalSeconds} seconds`,
			);
	}
	throw new NonRetryableError(
		`Research ${batch.id} exceeded its polling allowance`,
	);
}

/** Researches every batch subject and records malformed, missing, duplicate and foreign output IDs explicitly. */
export async function runResearchBatch(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	candidates: readonly Candidate[],
	index: number,
) {
	if (!canPurchase(progress, MEDIUM_AGENT_DOLLARS)) {
		progress.capped = true;
		return [];
	}
	const name = `research-${index}`;
	let started: { id: string } | null = null;
	const beforePoll = progress.ledger.total();
	try {
		const start = await ctx.step.do(
			`people-${progress.company.domain}-${name}-start`,
			config.stepConfig.paidCall,
			() =>
				purchase(async () => ({
					value: await startAgentRun(
						researchRequest({
							company: progress.company,
							buyer: ctx.buyer,
							candidates,
						}),
						ctx.env,
					),
					costDollars: 0,
				})),
		);
		started = start.value;
		const active = await bankPeoplePurchase(
			ctx,
			progress,
			`${name}-start`,
			start,
		);
		const output = await pollBatch(ctx, progress, {
			id: active.id,
			name,
			billed: 0,
		});
		const result = researchSubjects(candidates, output);
		await recordPeopleEvidence(ctx, progress, `${name}-coverage`, result);
		progress.researched += result.people.length;
		progress.capped ||=
			result.people.length !== candidates.length ||
			result.completeness.foreign.length > 0 ||
			result.completeness.duplicated.length > 0 ||
			result.malformed > 0;
		return result.people;
	} catch (error) {
		if (started)
			await settleBatch(ctx, progress, {
				id: started.id,
				name,
				billed: progress.ledger.total() - beforePoll,
			});
		else await unknownBilling(ctx, progress, name, null);
		throw error;
	}
}
