import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { config } from "@/config";
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
	): Promise<EnrichOutcome[]> {
		const { runId, channels } = event.payload;
		const subjects = await step.do(
			"resolve-subjects",
			config.stepConfig.databaseWork,
			() => subjectsForRun(this.env, runId),
		);
		const outcomes: EnrichOutcome[] = [];
		for (const [index, batch] of toBatches(subjects).entries()) {
			const batchOutcomes = await step.do(
				`enrich-batch-${index}`,
				config.stepConfig.vendorWork,
				() => enrich(batch, channels, { env: this.env }),
			);
			outcomes.push(...batchOutcomes);
		}
		return outcomes;
	}
}
