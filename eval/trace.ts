import type { RunReport } from "@eval/headline";
import type { KeyFile } from "@eval/label-core";
import { emptyKeyFile } from "@eval/label-core";
import { BRAINTRUST_PROJECT } from "@eval/profiles";
import type {
	CompanyTraceRecord,
	RoundRefusalRow,
	RoundTraceRecord,
} from "@eval/read";
import {
	readCompanyTraceRecords,
	readHardRecordRequirementTexts,
	readRequiresProvingPass,
	readRoundRefusals,
	readRoundTraceRecords,
	readRunReport,
} from "@eval/read";
import type {
	PeopleCompanyTraceRecord,
	PickTraceRecord,
} from "@eval/read-people";
import { readPeopleTraceRecords } from "@eval/read-people";
import {
	gateProven,
	keyAccepted,
	queryCarriesHardRequirements,
	routeMatchesShape,
	titleInBand,
	verifiedTwoSources,
} from "@eval/scorers";
import type { Span } from "braintrust";
import { currentSpan, initLogger } from "braintrust";
import type { Sql } from "postgres";
import postgres from "postgres";

export type SpanMetadataValue =
	| string
	| number
	| boolean
	| null
	| readonly string[];

export type SpanSpec = {
	name: string;
	input?: unknown;
	output?: unknown;
	expected?: string | null;
	scores?: Record<string, number | null>;
	metadata?: Record<string, SpanMetadataValue>;
	children: SpanSpec[];
};

export type RunTraceMeta = {
	profile: string;
	arm: string;
	trial: number;
	commit: string;
};

function wallClockSeconds(run: RunReport): number | null {
	if (!run.finishedAt) return null;
	return (
		(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) /
		1000
	);
}

function routeSummary(rounds: readonly RoundTraceRecord[]): string {
	const counts = new Map<string, number>();
	for (const round of rounds) {
		const route = round.route ?? "unknown";
		counts.set(route, (counts.get(route) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([route, count]) => `${count} ${route}`)
		.join(", ");
}

function judgeSpan(refused: readonly RoundRefusalRow[]): SpanSpec {
	return { name: "judge", output: { refused }, children: [] };
}

function refusedSpan(refused: readonly RoundRefusalRow[]): SpanSpec {
	return {
		name: "refused",
		output: refused.map((row) => ({ domain: row.domain, reason: row.reason })),
		children: [],
	};
}

function roundSpan(
	round: RoundTraceRecord,
	refused: readonly RoundRefusalRow[],
	requiresProvingPass: boolean,
	hardRecordRequirementTexts: readonly string[],
): SpanSpec {
	const query = round.plans[0]?.query ?? null;
	return {
		name: `round-${round.ordinal}`,
		input: {
			query,
			angles: round.plans.map((plan) => plan.angle),
			bounds: round.plans[0]
				? {
						minWorkforce: round.plans[0].minWorkforce ?? null,
						maxWorkforce: round.plans[0].maxWorkforce ?? null,
					}
				: null,
			countries: round.plans[0]?.countries ?? [],
			route: round.route,
		},
		output: {
			funnel: round.funnel,
			carriesHardRequirements: query
				? queryCarriesHardRequirements(query, hardRecordRequirementTexts)
				: null,
		},
		scores: {
			route_matches_shape: routeMatchesShape({
				requiresProvingPass,
				route: round.route,
			}),
		},
		metadata: {
			ordinal: round.ordinal,
			seconds: round.seconds,
			requiresProvingPass,
		},
		children: [judgeSpan(refused), refusedSpan(refused)],
	};
}

function companySpan(
	company: CompanyTraceRecord,
	key: KeyFile,
	requiresProvingPass: boolean,
): SpanSpec {
	const label = key.companies[company.domain]?.label ?? null;
	return {
		name: `company-${company.domain}`,
		input: {
			record: { name: company.name, industry: company.industry },
			description: company.description,
		},
		output: {
			citedPage: company.citedPage,
			quote: company.quote,
			evidenceCheck: company.evidenceCheck,
			fitReason: company.fitReason,
		},
		expected: label,
		scores: {
			key_accepted: keyAccepted({ label }),
			gate_proven: gateProven({
				requiresProvingPass,
				citedPage: company.citedPage,
				evidenceCheck: company.evidenceCheck,
			}),
		},
		metadata: { domain: company.domain, requiresProvingPass },
		children: [],
	};
}

export type CompanyRunTraceInput = {
	run: RunReport;
	meta: RunTraceMeta;
	rounds: readonly RoundTraceRecord[];
	refusalsByRound: ReadonlyMap<number, RoundRefusalRow[]>;
	companies: readonly CompanyTraceRecord[];
	key: KeyFile;
	requiresProvingPass: boolean;
	hardRecordRequirementTexts: readonly string[];
};

/** The whole span tree for one companies run, built purely from already-read data: no IO, so it is testable without Braintrust. */
export function buildCompanyRunTrace(input: CompanyRunTraceInput): SpanSpec {
	const {
		run,
		meta,
		rounds,
		refusalsByRound,
		companies,
		key,
		requiresProvingPass,
		hardRecordRequirementTexts,
	} = input;
	return {
		name: "companies-run",
		metadata: {
			...meta,
			count: companies.length,
			routeSummary: routeSummary(rounds),
			costDollars: run.costDollars,
			seconds: wallClockSeconds(run),
		},
		children: [
			...rounds.map((round) =>
				roundSpan(
					round,
					refusalsByRound.get(round.ordinal) ?? [],
					requiresProvingPass,
					hardRecordRequirementTexts,
				),
			),
			...companies.map((company) =>
				companySpan(company, key, requiresProvingPass),
			),
		],
	};
}

function pickSpan(pick: PickTraceRecord, index: number): SpanSpec {
	return {
		name: pick.name ? `pick-${pick.name}` : `pick-${index}`,
		input: { name: pick.name, title: pick.title },
		output: {
			verified: pick.verified,
			verdict: pick.verdict,
			indexEmployer: pick.indexEmployer,
			agreement: pick.agreement,
			quoteCheck: pick.quoteCheck,
		},
		scores: {
			title_in_band: titleInBand(pick.title),
			verified_two_sources: verifiedTwoSources({
				verdict: pick.verdict,
				agreement: pick.agreement,
				quoteCheckFound: pick.quoteCheck?.found ?? null,
			}),
		},
		children: [],
	};
}

function peopleCompanySpan(company: PeopleCompanyTraceRecord): SpanSpec {
	return {
		name: `company-${company.domain}`,
		input: { identity: company.identity, mode: company.mode },
		output: { rosterSize: company.rosterSize, pickCount: company.picks.length },
		children: company.picks.map(pickSpan),
	};
}

export type PeopleRunTraceInput = {
	run: RunReport;
	meta: RunTraceMeta;
	companies: readonly PeopleCompanyTraceRecord[];
};

/** The whole span tree for one people run, built purely from already-read data. */
export function buildPeopleRunTrace(input: PeopleRunTraceInput): SpanSpec {
	const { run, meta, companies } = input;
	return {
		name: "people-run",
		metadata: {
			...meta,
			count: companies.length,
			costDollars: run.costDollars,
			seconds: wallClockSeconds(run),
		},
		children: companies.map(peopleCompanySpan),
	};
}

export type CompanyScoringContext = { icpId: string; key: KeyFile };

export async function traceCompaniesRun(
	sql: Sql,
	runId: string,
	scoring: CompanyScoringContext,
	meta: RunTraceMeta,
): Promise<SpanSpec> {
	const run = await readRunReport(sql, runId);
	const rounds = await readRoundTraceRecords(sql, runId, run.finishedAt);
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

export async function tracePeopleRun(
	sql: Sql,
	runId: string,
	meta: RunTraceMeta,
): Promise<SpanSpec> {
	const run = await readRunReport(sql, runId);
	const companies = await readPeopleTraceRecords(sql, runId);
	return buildPeopleRunTrace({ run, meta, companies });
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

async function manualIcpId(sql: Sql, runId: string): Promise<string> {
	const rows = await sql`select icp_id as "icpId" from run where id = ${runId}`;
	const icpId = rows[0]?.icpId;
	if (typeof icpId !== "string") {
		throw new Error(`eval: trace found no icp for run ${runId}`);
	}
	return icpId;
}

async function main(): Promise<void> {
	const runId = process.argv[2];
	if (!runId) throw new Error("eval: trace needs a run id");
	const peopleRunId = process.argv[3] ?? null;
	const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
	const meta: RunTraceMeta = {
		profile: "manual",
		arm: "manual",
		trial: 0,
		commit: "manual",
	};
	try {
		const icpId = await manualIcpId(sql, runId);
		const scoring = { icpId, key: emptyKeyFile("manual", icpId) };
		await logTrace(await traceCompaniesRun(sql, runId, scoring, meta));
		if (peopleRunId)
			await logTrace(await tracePeopleRun(sql, peopleRunId, meta));
	} finally {
		await sql.end();
	}
}

if (import.meta.main) {
	await main();
}
