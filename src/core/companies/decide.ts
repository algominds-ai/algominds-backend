import type { FindCompaniesReject } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type { RequirementStatus, Verdict } from "@/core/companies/judge";
import { normalizeDomain } from "@/core/db/schema";
import type { Requirement } from "@/core/requirements";
import { hardPageRequirements, hardRequirements } from "@/core/requirements";

export type Decision = {
	stored: CompanyRow[];
	rejects: FindCompaniesReject[];
};

function statusOf(verdict: Verdict | undefined, id: string): RequirementStatus {
	return (
		verdict?.statuses.find((entry) => entry.id === id)?.status ?? "unproven"
	);
}

/** The first hard requirement a row's own record or evidence contradicts, or null when none does. */
export function contradictedRequirement(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): Requirement | null {
	return (
		hardRequirements(requirements).find(
			(req) => statusOf(verdict, req.id) === "contradicted",
		) ?? null
	);
}

/** The first hard page requirement no cited page has proven for a row, or null when every one of them is proven. */
export function unprovenRequirement(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): Requirement | null {
	return (
		hardPageRequirements(requirements).find(
			(req) => statusOf(verdict, req.id) !== "proven",
		) ?? null
	);
}

/**
 * Whether one judged row is stored. A hard requirement the row contradicts
 * refuses it. A hard requirement that only a page can settle must be `proven`
 * from a cited page, and every row reaches the judge with its evidence already
 * attached, so `unproven` there means no page proved it and the row is
 * refused. A hard requirement the record settles is judged on the record, so
 * `unproven` keeps the row: a record that states nothing is silence, not a
 * contradiction. Soft requirements never gate.
 */
export function keepsRow(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): boolean {
	return (
		contradictedRequirement(requirements, verdict) === null &&
		unprovenRequirement(requirements, verdict) === null
	);
}

function refusalReason(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): string {
	const detail = verdict?.reason ?? "the judge gave no reason";
	const bad = contradictedRequirement(requirements, verdict);
	if (bad !== null) return `contradicts ${bad.id}: ${detail}`;
	const missing = unprovenRequirement(requirements, verdict);
	return `no page proved ${missing?.id ?? "a required signal"}: ${detail}`;
}

/**
 * The rows one round's judged batch collapses away: a row the judge marked as
 * the same organisation as another row in the batch, so one group is stored
 * once under one brand. A row naming itself, or an index outside the batch, is
 * not a collapse.
 */
export function collapsedIndices(
	verdicts: readonly Verdict[],
	rowCount: number,
): Set<number> {
	const collapsed = new Set<number>();
	for (const verdict of verdicts) {
		const other = verdict.sameOrganizationAs;
		if (other === null || other === verdict.index) continue;
		if (other < 0 || other >= rowCount) continue;
		collapsed.add(verdict.index);
	}
	return collapsed;
}

export type DecideInput = {
	requirements: readonly Requirement[];
	rows: readonly CompanyRow[];
	verdicts: readonly Verdict[];
	excluded: ReadonlySet<string>;
};

/** Whether a row belongs to an organisation this run must not return: its own domain is excluded, or the judge says it is the same organisation as a row whose domain is. */
export function excludedRow(
	rows: readonly CompanyRow[],
	index: number,
	verdict: Verdict | undefined,
	excluded: ReadonlySet<string>,
): boolean {
	const own = rows[index]?.domain;
	if (own !== null && own !== undefined && excluded.has(normalizeDomain(own)))
		return true;
	const other = verdict?.sameOrganizationAs;
	if (other === null || other === undefined) return false;
	const parent = rows[other]?.domain;
	return (
		parent !== null &&
		parent !== undefined &&
		excluded.has(normalizeDomain(parent))
	);
}

/**
 * Applies the refusal policy to one judged batch: brand duplicates collapse to
 * one row, a contradicted hard requirement refuses, a hard page requirement no
 * page proved refuses, and everything else is stored.
 */
export function decideRows(input: DecideInput): Decision {
	const { requirements, rows, verdicts, excluded } = input;
	const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
	const collapsed = collapsedIndices(verdicts, rows.length);
	const stored: CompanyRow[] = [];
	const rejects: FindCompaniesReject[] = [];
	rows.forEach((row, index) => {
		const verdict = byIndex.get(index);
		if (excludedRow(rows, index, verdict, excluded)) {
			rejects.push({
				domain: row.domain,
				reason: "already found for this account, or a brand of one that was",
				stage: "gate",
				group: "a company this account already holds",
			});
			return;
		}
		if (collapsed.has(index)) {
			rejects.push({
				domain: row.domain,
				reason: "the same organisation as another company in this round",
				stage: "judge",
				group: "one organisation under more than one brand",
			});
			return;
		}
		if (keepsRow(requirements, verdict)) stored.push(row);
		else
			rejects.push({
				domain: row.domain,
				reason: refusalReason(requirements, verdict),
				stage: "judge",
			});
	});
	return { stored, rejects };
}

/** The share of a round's candidates whose hard page requirements the judge proved, as words the next round's planner reads. Null when the profile asks for no page proof. */
export function provenRate(
	requirements: readonly Requirement[],
	verdicts: readonly Verdict[],
): string | null {
	if (hardPageRequirements(requirements).length === 0) return null;
	const proven = verdicts.filter(
		(verdict) => unprovenRequirement(requirements, verdict) === null,
	).length;
	return `${proven} of ${verdicts.length}`;
}
