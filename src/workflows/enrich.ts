import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import {
	accountSpendToday,
	closeRun,
	findRun,
	openRun,
	recordRunSpend,
} from "@/core/db/queries";
import type {
	EnrichChannel,
	EnrichOutcome,
	EnrichSubject,
} from "@/core/enrich";
import { enrich, subjectsForRun } from "@/core/enrich";

const BATCH_SIZE = config.enrich.batchSize;

export type EnrichWorkflowParams = {
	runId: string;
	channels: EnrichChannel[];
};

export type EnrichWorkflowResult = {
	outcomes: EnrichOutcome[];
	costDollars: number;
};

/** Splits `subjects` into ordered groups of `BATCH_SIZE`. */
export function toBatches(subjects: EnrichSubject[]): EnrichSubject[][] {
	const batches: EnrichSubject[][] = [];
	for (let start = 0; start < subjects.length; start += BATCH_SIZE) {
		batches.push(subjects.slice(start, start + BATCH_SIZE));
	}
	return batches;
}

export class EnrichWorkflow extends WorkflowEntrypoint<
	Env,
	EnrichWorkflowParams
> {
	override async run(
		event: WorkflowEvent<EnrichWorkflowParams>,
		step: WorkflowStep,
	): Promise<EnrichWorkflowResult> {
		const { runId, channels } = event.payload;
		const subjects = await step.do(
			"resolve-subjects",
			config.stepConfig.databaseCall,
			() => subjectsForRun(this.env, runId),
		);
		const source = await step.do(
			"load-source-run",
			config.stepConfig.databaseCall,
			async () => {
				const row = await findRun(this.env, runId);
				if (!row) throw new NonRetryableError(`enrich: unknown run ${runId}`);
				return { accountId: row.accountId, icpId: row.icpId };
			},
		);

		await step.do("daily-ceiling", config.stepConfig.databaseCall, async () => {
			const spent = await accountSpendToday(this.env, source.accountId);
			if (spent >= config.spend.perAccountDailyDollars) {
				throw new NonRetryableError(
					`daily ceiling reached for this account: ${spent} of ${config.spend.perAccountDailyDollars} dollars`,
				);
			}
			return { spent };
		});

		await step.do("open-run", config.stepConfig.databaseCall, () =>
			openRun(this.env, {
				id: event.instanceId,
				accountId: source.accountId,
				icpId: source.icpId,
				capability: "enrich",
				status: "running",
			}),
		);

		const outcomes: EnrichOutcome[] = [];
		let costDollars = 0;
		for (const [index, batch] of toBatches(subjects).entries()) {
			const batchResult = await step.do(
				`enrich-batch-${index}`,
				config.stepConfig.paidCall,
				() => enrich(batch, channels, { env: this.env }),
			);
			outcomes.push(...batchResult.outcomes);
			costDollars += batchResult.costDollars;
			await step.do(
				`enrich-batch-${index}-spend`,
				config.stepConfig.databaseCall,
				() => recordRunSpend(this.env, event.instanceId, costDollars),
			);
			if (costDollars >= config.spend.perRunDollars) break;
		}
		await step.do("close-run", config.stepConfig.databaseCall, () =>
			closeRun(this.env, event.instanceId, {
				status: "complete",
				costDollars,
			}),
		);

		return { outcomes, costDollars };
	}
}
