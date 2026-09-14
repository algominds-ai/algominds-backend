import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import { toBatches } from "@/core/batches";
import {
	assertUnderDailyCeiling,
	closeErroredRun,
	closeRun,
	findRun,
	openRun,
	recordRunSpend,
} from "@/core/db/queries";
import type { EnrichChannel, EnrichOutcome } from "@/core/enrich";
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
export class EnrichWorkflow extends WorkflowEntrypoint<
	Env,
	EnrichWorkflowParams
> {
	override async run(
		event: WorkflowEvent<EnrichWorkflowParams>,
		step: WorkflowStep,
	): Promise<EnrichWorkflowResult> {
		try {
			return await this.runToCompletion(event, step);
		} catch (error) {
			await step.do("close-errored", config.stepConfig.databaseCall, () =>
				closeErroredRun(this.env, event.instanceId),
			);
			throw error;
		}
	}

	private async runToCompletion(
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
				return { organizationId: row.organizationId, icpId: row.icpId };
			},
		);

		const alreadySpent = await step.do(
			"open-run",
			config.stepConfig.databaseCall,
			async () => {
				await assertUnderDailyCeiling(this.env, source.organizationId);
				const row = await openRun(this.env, {
					id: event.instanceId,
					organizationId: source.organizationId,
					icpId: source.icpId,
					capability: "enrich",
					status: "running",
				});
				return { alreadySpent: row.costDollars };
			},
		);

		const outcomes: EnrichOutcome[] = [];
		let costDollars = alreadySpent.alreadySpent;
		for (const [index, batch] of toBatches(subjects, BATCH_SIZE).entries()) {
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
