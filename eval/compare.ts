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
	precision: MetricDiff;
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
	precision: number | null;
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
 * an error. Pure: no Braintrust IO, so this is the tested half of the
 * comparison.
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
			precision: metricDiff(curr.precision, prev?.precision ?? null),
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
	scores: z.object({ precision: z.number().nullish() }).optional(),
});

type ExperimentRow = z.infer<typeof ExperimentRowSchema>;

function emptySnapshot(profile: string): ExperimentProfileSnapshot {
	return {
		profile,
		count: 0,
		costDollars: 0,
		seconds: null,
		precision: null,
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
		precision: scores?.precision ?? snapshot.precision,
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

/** One `ExperimentProfileSnapshot` per profile, folded from the raw rows a fetched experiment carries — the root `companies-run` span for count/cost/seconds/precision, and every `company-<domain>` span for the domain set. Pure, so it is tested without a live Braintrust connection. */
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

const BASELINE_ARM = "baseline";

/**
 * The most recently created baseline experiment in this project other than
 * `excludeName`, the experiment this run just wrote. Null when no baseline
 * has been recorded yet.
 */
async function findLatestBaselineName(
	excludeName: string,
	apiKey: string,
): Promise<string | null> {
	const params = new URLSearchParams({
		project_name: BRAINTRUST_PROJECT,
		metadata: JSON.stringify({ arm: BASELINE_ARM }),
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

/** The full comparison for one just-finished experiment against the latest baseline experiment, or an empty comparison when no baseline exists yet. */
export async function compareToBaseline(
	experimentName: string,
	apiKey: string,
): Promise<ExperimentComparison> {
	const previousExperiment = await findLatestBaselineName(
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

/** One printable block per profile: precision, cost and seconds per stored company against the baseline experiment, and which companies appeared or disappeared. */
export function formatComparison(comparison: ExperimentComparison): string {
	if (!comparison.previousExperiment) {
		return "eval: no baseline experiment yet — nothing to compare";
	}
	const lines = [`eval: comparing against ${comparison.previousExperiment}`];
	for (const profile of comparison.profiles) {
		lines.push(
			`  ${profile.profile}: precision ${fmt(profile.precision.current, 2)} (was ${fmt(profile.precision.previous, 2)}), ` +
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
