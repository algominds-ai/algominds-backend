import type { KeyFile } from "@eval/label-core";
import { BRAINTRUST_PROJECT } from "@eval/profiles";
import {
	readCompanyTraceRecords,
	readHardRecordRequirementTexts,
	readRequiresProvingPass,
	readRoundRefusals,
	readRoundTraceRecords,
	readRunReport,
} from "@eval/read";
import type {
	RunTraceMeta,
	SpanMetadataValue,
	SpanSpec,
} from "@eval/trace-spans";
import { buildCompanyRunTrace } from "@eval/trace-spans";
import type { Span } from "braintrust";
import { currentSpan, initLogger } from "braintrust";
import type { Sql } from "postgres";

export type {
	CompanyRunTraceInput,
	RunTraceMeta,
	SpanMetadataValue,
	SpanSpec,
} from "@eval/trace-spans";
export { buildCompanyRunTrace } from "@eval/trace-spans";

export type CompanyScoringContext = { icpId: string; key: KeyFile };

export async function traceCompaniesRun(
	sql: Sql,
	runId: string,
	scoring: CompanyScoringContext,
	meta: RunTraceMeta,
): Promise<SpanSpec> {
	const run = await readRunReport(sql, runId);
	const rounds = await readRoundTraceRecords(sql, run);
	const refusalsByRound = await readRoundRefusals(sql, runId);
	const companies = await readCompanyTraceRecords(sql, runId);
	const requiresProvingPass = await readRequiresProvingPass(sql, scoring.icpId);
	const hardRecordRequirementTexts = await readHardRecordRequirementTexts(
		sql,
		scoring.icpId,
	);
	return buildCompanyRunTrace({
		run,
		meta,
		rounds,
		refusalsByRound,
		companies,
		key: scoring.key,
		requiresProvingPass,
		hardRecordRequirementTexts,
	});
}

function logChildren(span: Span, children: readonly SpanSpec[]): void {
	for (const child of children) {
		span.traced(
			(childSpan) => {
				logChildren(childSpan, child.children);
			},
			{ name: child.name, event: childEvent(child) },
		);
	}
}

function childEvent(spec: SpanSpec): {
	input: unknown;
	output: unknown;
	expected?: string | null;
	scores?: Record<string, number | null>;
	metadata?: Record<string, SpanMetadataValue>;
} {
	return {
		input: spec.input,
		output: spec.output,
		...(spec.expected !== undefined ? { expected: spec.expected } : {}),
		...(spec.scores ? { scores: spec.scores } : {}),
		...(spec.metadata ? { metadata: spec.metadata } : {}),
	};
}

/**
 * Attaches this trace's own scores and every child span onto the
 * currently active Braintrust span, rather than opening a new root — used
 * inside `Eval()`'s task, whose per-case span already exists, so every
 * scorer's score lands on the experiment alongside the round and company
 * it scored.
 */
export function attachTraceToCurrentSpan(spec: SpanSpec): void {
	const span = currentSpan();
	span.log(childEvent(spec));
	logChildren(span, spec.children);
}

/**
 * Logs one span tree to Braintrust project logs through `initLogger` and
 * `Span.traced`, so a run's trace is browsable in the UI. Flushes before
 * returning. `projectId`, when given, skips the project-name lookup call —
 * a test passes one so logging against a test transport never reaches the
 * network.
 */
export async function logTrace(
	spec: SpanSpec,
	projectId?: string,
): Promise<void> {
	const logger = initLogger({
		projectName: BRAINTRUST_PROJECT,
		...(projectId ? { projectId } : {}),
	});
	logger.traced(
		(span) => {
			logChildren(span, spec.children);
		},
		{ name: spec.name, event: childEvent(spec) },
	);
	await logger.flush();
}
