import type { RunReport } from "@eval/headline";
import type { KeyFile } from "@eval/label-core";
import type {
	CompanyTraceRecord,
	RoundRefusalRow,
	RoundTraceRecord,
} from "@eval/read";
import {
	gateProven,
	keyAccepted,
	queryCarriesHardRequirements,
	routeMatchesShape,
} from "@eval/scorers";

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

/**
 * One refused row's own span, carrying the same `domain`/`headcountTotal`/
 * `country`/`fitReason`/`judgeReason` metadata shape a company span carries
 * — headcount and country are always null here since a refused row was
 * never stored as a company record — so one preprocessor reads either kind
 * of span uniformly for topic clustering over recurring refusal causes.
 */
function refusedRowSpan(row: RoundRefusalRow): SpanSpec {
	return {
		name: `refused-${row.domain ?? "unknown"}`,
		output: { domain: row.domain, reason: row.reason, statuses: row.statuses },
		metadata: {
			domain: row.domain,
			headcountTotal: null,
			country: null,
			fitReason: null,
			judgeReason: row.reason,
		},
		children: [],
	};
}

function refusedSpan(refused: readonly RoundRefusalRow[]): SpanSpec {
	return {
		name: "refused",
		output: refused.map((row) => ({ domain: row.domain, reason: row.reason })),
		children: refused.map(refusedRowSpan),
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
			secondsByDep: round.secondsByDep,
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

type HeadcountBand = { min: number | null; max: number | null };

type CompanyScoringMeta = {
	profile: string;
	key: KeyFile;
	requiresProvingPass: boolean;
	requirementsText: string;
	headcountBand: HeadcountBand;
};

function companySpan(
	company: CompanyTraceRecord,
	scoring: CompanyScoringMeta,
): SpanSpec {
	const { profile, key, requiresProvingPass, requirementsText, headcountBand } =
		scoring;
	const label = key.companies[company.domain]?.label ?? null;
	return {
		name: `company-${company.domain}`,
		input: {
			record: {
				name: company.name,
				industry: company.industry,
				workforceTotal: company.workforceTotal,
			},
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
		metadata: {
			profile,
			domain: company.domain,
			requiresProvingPass,
			requirementsText,
			headcountMin: headcountBand.min,
			headcountMax: headcountBand.max,
			headcountTotal: company.workforceTotal,
			country: company.country,
			fitReason: company.fitReason,
			judgeReason: null,
		},
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

function headcountBandOf(rounds: readonly RoundTraceRecord[]): HeadcountBand {
	const plan = rounds[0]?.plans[0];
	return { min: plan?.minWorkforce ?? null, max: plan?.maxWorkforce ?? null };
}

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
	const companyScoring: CompanyScoringMeta = {
		profile: meta.profile,
		key,
		requiresProvingPass,
		requirementsText: hardRecordRequirementTexts.join("; "),
		headcountBand: headcountBandOf(rounds),
	};
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
			...companies.map((company) => companySpan(company, companyScoring)),
		],
	};
}
