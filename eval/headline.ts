import type { KeyFile } from "@eval/label-core";
import type { ProfileBars } from "@eval/profiles";

export type RunReport = {
	runId: string;
	costDollars: number;
	startedAt: string;
	finishedAt: string | null;
};

export type StoredCompanyRecord = {
	domain: string;
	name: string | null;
	citedPage: string | null;
	quote: string | null;
	evidenceCheck: string | null;
	provingPageStored: boolean;
};

export type CorrectnessGates = {
	noKeyRejectedStored: boolean;
	noDuplicateOrganisationGroup: boolean;
	provingPassesWhereRequired: boolean;
	recordBoundsHold: boolean;
	costUnderBar: boolean;
	secondsUnderBar: boolean;
};

export type Verdict = {
	runId: string;
	gates: CorrectnessGates;
	allGatesPass: boolean;
	storedCount: number;
	precision: number | null;
	unlabelledStoredCount: number;
	costPerStoredCompany: number | null;
	secondsPerStoredCompany: number | null;
};

const MAX_SAME_AS_HOPS = 10;

/**
 * The domain a `same-as:<domain>` chain in the key ultimately points to, or
 * `domain` itself when the key names no alias for it. Stops after
 * `MAX_SAME_AS_HOPS` hops so a cycle a human mistypes cannot loop forever.
 */
export function canonicalDomain(key: KeyFile, domain: string): string {
	let current = domain;
	for (let hop = 0; hop < MAX_SAME_AS_HOPS; hop++) {
		const label = key.companies[current]?.label;
		if (!label?.startsWith("same-as:")) return current;
		current = label.slice("same-as:".length);
	}
	return current;
}

function noKeyRejectedStored(
	key: KeyFile,
	stored: readonly StoredCompanyRecord[],
): boolean {
	return stored.every(
		(row) => !key.companies[row.domain]?.label?.startsWith("reject:"),
	);
}

function noDuplicateOrganisationGroup(
	key: KeyFile,
	stored: readonly StoredCompanyRecord[],
): boolean {
	const canonical = stored.map((row) => canonicalDomain(key, row.domain));
	return new Set(canonical).size === canonical.length;
}

function provingPassesWhereRequired(
	requiresProvingPass: boolean,
	stored: readonly StoredCompanyRecord[],
): boolean {
	if (!requiresProvingPass) return true;
	return stored.every(
		(row) =>
			row.citedPage !== null &&
			row.evidenceCheck === "found" &&
			row.provingPageStored,
	);
}

function recordBoundsHold(stored: readonly StoredCompanyRecord[]): boolean {
	return stored.every((row) => row.domain.length > 0 && row.name !== null);
}

function wallClockSeconds(run: RunReport): number | null {
	if (!run.finishedAt) return null;
	const started = new Date(run.startedAt).getTime();
	const finished = new Date(run.finishedAt).getTime();
	return (finished - started) / 1000;
}

function perCompany(total: number | null, count: number): number | null {
	if (total === null || count === 0) return null;
	return total / count;
}

export type VerdictInput = {
	key: KeyFile;
	run: RunReport;
	bars: ProfileBars;
	requiresProvingPass: boolean;
	stored: readonly StoredCompanyRecord[];
};

/**
 * The lexicographic verdict for one run: correctness gates first, then
 * cost and seconds per stored company. Precision, accepted over labelled
 * stored companies, is reported as a score but never ranks, because a
 * stored reject already fails a gate. Round-level route, funnel and yield
 * are diagnostics attached separately and never enter this computation.
 */
export function computeVerdict(input: VerdictInput): Verdict {
	const { key, run, bars, requiresProvingPass, stored } = input;
	const seconds = wallClockSeconds(run);
	const gates: CorrectnessGates = {
		noKeyRejectedStored: noKeyRejectedStored(key, stored),
		noDuplicateOrganisationGroup: noDuplicateOrganisationGroup(key, stored),
		provingPassesWhereRequired: provingPassesWhereRequired(
			requiresProvingPass,
			stored,
		),
		recordBoundsHold: recordBoundsHold(stored),
		costUnderBar: run.costDollars <= bars.maxCostDollars,
		secondsUnderBar: seconds === null || seconds <= bars.maxSeconds,
	};
	const labels = stored.map((row) => key.companies[row.domain]?.label ?? null);
	const acceptedStored = labels.filter((label) => label === "accept").length;
	const labelledStored = labels.filter((label) => label !== null).length;
	const unlabelledStoredCount = stored.filter(
		(row) =>
			key.companies[row.domain]?.label === null ||
			key.companies[row.domain] === undefined,
	).length;
	return {
		runId: run.runId,
		gates,
		allGatesPass: Object.values(gates).every(Boolean),
		storedCount: stored.length,
		precision: labelledStored === 0 ? null : acceptedStored / labelledStored,
		unlabelledStoredCount,
		costPerStoredCompany: perCompany(run.costDollars, stored.length),
		secondsPerStoredCompany: perCompany(seconds, stored.length),
	};
}

function rank(value: number | null, worstFirst: boolean): number {
	if (value === null)
		return worstFirst ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
	return value;
}

/**
 * Negative when `a` is the better run, positive when `b` is, zero when the
 * lexicographic order cannot separate them. The order is fixed at build
 * time — gates, then cost, then seconds — so no run of the eval ever picks
 * a different metric to break a tie after the fact.
 */
export function compareVerdicts(a: Verdict, b: Verdict): number {
	if (a.allGatesPass !== b.allGatesPass) return a.allGatesPass ? -1 : 1;
	const cost =
		rank(a.costPerStoredCompany, true) - rank(b.costPerStoredCompany, true);
	if (cost !== 0) return cost;
	return (
		rank(a.secondsPerStoredCompany, true) -
		rank(b.secondsPerStoredCompany, true)
	);
}
