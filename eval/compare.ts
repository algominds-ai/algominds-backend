import { BRAINTRUST_PROJECT } from "@eval/profiles";
import { initExperiment } from "braintrust";
import { z } from "zod";

type MetricDiff = {
	current: number | null;
	previous: number | null;
	diff: number | null;
};

type ProfileComparison = {
	profile: string;
	coverage: MetricDiff;
	costPerCompany: MetricDiff;
	secondsPerCompany: MetricDiff;
	appeared: string[];
	disappeared: string[];
};

type ExperimentProfileSnapshot = {
	profile: string;
	count: number;
	costDollars: number;
	seconds: number | null;
	qualifiedCoverage: number | null;
	domains: readonly string[];
};

function metricDiff(
	current: number | null,
	previous: number | null,
): MetricDiff {
	return {
		current,
		previous,
		diff: current !== null && previous !== null ? current - previous : null,
	};
}

function perCompany(total: number | null, count: number): number | null {
	return total !== null && count > 0 ? total / count : null;
}

/**
 * One `ProfileComparison` per profile the current run measured, against
 * whatever the previous snapshot recorded for that same profile — a
 * profile absent from the previous snapshot compares against nulls, not
 * an error. Pure: no Braintrust IO, so this is the tested half of
 * deliverable 3's comparison.
 */
function diffProfiles(
	current: readonly ExperimentProfileSnapshot[],
	previous: readonly ExperimentProfileSnapshot[],
): ProfileComparison[] {
	const byProfile = new Map(
		previous.map((snapshot) => [snapshot.profile, snapshot]),
	);
	return current.map((curr) => {
		const prev = byProfile.get(curr.profile) ?? null;
		const currentDomains = new Set(curr.domains);
		const previousDomains = new Set(prev?.domains ?? []);
		return {
			profile: curr.profile,
			coverage: metricDiff(
				curr.qualifiedCoverage,
				prev?.qualifiedCoverage ?? null,
			),
			costPerCompany: metricDiff(
				perCompany(curr.costDollars, curr.count),
				prev ? perCompany(prev.costDollars, prev.count) : null,
			),
			secondsPerCompany: metricDiff(
				perCompany(curr.seconds, curr.count),
				prev ? perCompany(prev.seconds, prev.count) : null,
			),
			appeared: [...currentDomains]
				.filter((domain) => !previousDomains.has(domain))
				.sort(),
			disappeared: [...previousDomains]
				.filter((domain) => !currentDomains.has(domain))
				.sort(),
		};
	});
}

const ExperimentRowSchema = z.object({
	span_attributes: z.object({ name: z.string().optional() }).optional(),
	metadata: z
		.object({
			profile: z.string().optional(),
			count: z.number().optional(),
			costDollars: z.number().optional(),
			seconds: z.number().nullish(),
		})
		.optional(),
	scores: z.object({ qualified_coverage: z.number().nullish() }).optional(),
});

type ExperimentRow = z.infer<typeof ExperimentRowSchema>;

function emptySnapshot(profile: string): ExperimentProfileSnapshot {
	return {
		profile,
		count: 0,
		costDollars: 0,
		seconds: null,
		qualifiedCoverage: null,
		domains: [],
	};
}

function applyRootRow(
	snapshot: ExperimentProfileSnapshot,
	metadata: NonNullable<ExperimentRow["metadata"]>,
	scores: ExperimentRow["scores"],
): ExperimentProfileSnapshot {
	return {
		...snapshot,
		count: metadata.count ?? snapshot.count,
		costDollars: metadata.costDollars ?? snapshot.costDollars,
		seconds: metadata.seconds ?? snapshot.seconds,
		qualifiedCoverage: scores?.qualified_coverage ?? snapshot.qualifiedCoverage,
	};
}

const COMPANY_SPAN_PREFIX = "company-";

function foldOneRow(
	snapshot: ExperimentProfileSnapshot,
	row: ExperimentRow,
): ExperimentProfileSnapshot {
	const name = row.span_attributes?.name;
	if (name === "companies-run" && row.metadata) {
		return applyRootRow(snapshot, row.metadata, row.scores);
	}
	if (name?.startsWith(COMPANY_SPAN_PREFIX)) {
		return {
			...snapshot,
			domains: [...snapshot.domains, name.slice(COMPANY_SPAN_PREFIX.length)],
		};
	}
	return snapshot;
}

/** One `ExperimentProfileSnapshot` per profile, folded from the raw rows a fetched experiment carries — the root `companies-run` span for count/cost/seconds/coverage, and every `company-<domain>` span for the domain set. Pure, so it is tested without a live Braintrust connection. */
function snapshotsFromRows(
	rows: readonly unknown[],
): ExperimentProfileSnapshot[] {
	const byProfile = new Map<string, ExperimentProfileSnapshot>();
	for (const raw of rows) {
		const parsed = ExperimentRowSchema.safeParse(raw);
		const profile = parsed.success ? parsed.data.metadata?.profile : undefined;
		if (!parsed.success || !profile) continue;
		const snapshot = byProfile.get(profile) ?? emptySnapshot(profile);
		byProfile.set(profile, foldOneRow(snapshot, parsed.data));
	}
	return [...byProfile.values()];
}

/** Every profile's snapshot read back from one already-logged experiment, opened read-only by name. */
async function snapshotsFromExperiment(
	experimentName: string,
): Promise<ExperimentProfileSnapshot[]> {
	const experiment = initExperiment(BRAINTRUST_PROJECT, {
		experiment: experimentName,
		open: true,
	});
	const rows = await experiment.fetchedData();
	return snapshotsFromRows(rows);
}

const ListExperimentsResponseSchema = z.object({
	objects: z.array(z.object({ name: z.string() })),
});

/**
 * The most recently created experiment tagged with `arm` in this project,
 * other than `excludeName` (the experiment this run just wrote) — "the
 * previous experiment of the same arm" deliverable 3 compares against.
 * Null when this is the arm's first experiment.
 */
async function findPreviousExperimentName(
	arm: string,
	excludeName: string,
	apiKey: string,
): Promise<string | null> {
	const params = new URLSearchParams({
		project_name: BRAINTRUST_PROJECT,
		metadata: JSON.stringify({ arm }),
	});
	const response = await fetch(
		`https://api.braintrust.dev/v1/experiment?${params}`,
		{
			headers: { Authorization: `Bearer ${apiKey}` },
		},
	);
	if (!response.ok) return null;
	const parsed = ListExperimentsResponseSchema.safeParse(await response.json());
	if (!parsed.success) return null;
	return (
		parsed.data.objects.find((object) => object.name !== excludeName)?.name ??
		null
	);
}

type ExperimentComparison = {
	previousExperiment: string | null;
	profiles: ProfileComparison[];
};

/** The full comparison for one just-finished experiment against the previous experiment of the same arm, or an empty comparison when this is the arm's first run. */
export async function compareToPreviousExperiment(
	arm: string,
	experimentName: string,
	apiKey: string,
): Promise<ExperimentComparison> {
	const previousExperiment = await findPreviousExperimentName(
		arm,
		experimentName,
		apiKey,
	);
	if (!previousExperiment) return { previousExperiment: null, profiles: [] };
	const [current, previous] = await Promise.all([
		snapshotsFromExperiment(experimentName),
		snapshotsFromExperiment(previousExperiment),
	]);
	return { previousExperiment, profiles: diffProfiles(current, previous) };
}

function fmt(value: number | null, digits: number): string {
	return value === null ? "n/a" : value.toFixed(digits);
}

/** One printable block per profile: coverage, cost and seconds per stored company against the previous experiment, and which companies appeared or disappeared. */
export function formatComparison(comparison: ExperimentComparison): string {
	if (!comparison.previousExperiment) {
		return "eval: no previous experiment for this arm yet — nothing to compare";
	}
	const lines = [`eval: comparing against ${comparison.previousExperiment}`];
	for (const profile of comparison.profiles) {
		lines.push(
			`  ${profile.profile}: coverage ${fmt(profile.coverage.current, 2)} (was ${fmt(profile.coverage.previous, 2)}), ` +
				`$${fmt(profile.costPerCompany.current, 3)}/company (was $${fmt(profile.costPerCompany.previous, 3)}), ` +
				`${fmt(profile.secondsPerCompany.current, 1)}s/company (was ${fmt(profile.secondsPerCompany.previous, 1)}s)`,
		);
		if (profile.appeared.length > 0) {
			lines.push(`    appeared: ${profile.appeared.join(", ")}`);
		}
		if (profile.disappeared.length > 0) {
			lines.push(`    disappeared: ${profile.disappeared.join(", ")}`);
		}
	}
	return lines.join("\n");
}
