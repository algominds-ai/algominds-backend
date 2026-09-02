import type { CompanyCapture } from "@/core/companies/candidates";
import { toCompanyData } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type { Company, NewCompany, NewEvidence } from "@/core/db/schema";
import { normalizeDomain } from "@/core/db/schema";

const EVIDENCE_SOURCE = "exa";

export type NewCompanyContext = {
	icpId: string;
	runId: string;
	organizationId: string;
};

/** One judged row as the company row to store, or null when it lacks a name, a domain, or the vendor capture behind it. */
export function toNewCompany(
	row: CompanyRow,
	context: NewCompanyContext,
	capture: CompanyCapture | undefined,
): NewCompany | null {
	if (row.name === null || row.domain === null || capture === undefined)
		return null;
	return {
		icpId: context.icpId,
		organizationId: context.organizationId,
		domain: row.domain,
		name: row.name,
		linkedinUrl: row.linkedinUrl,
		industry: row.industry,
		data: toCompanyData(capture),
		runId: context.runId,
	};
}

/** The judged row a stored company came from, matched on the normalized domain the row was stored under. */
export function matchRow(
	rows: readonly CompanyRow[],
	saved: Company,
): CompanyRow | undefined {
	return rows.find(
		(row) =>
			row.domain !== null && normalizeDomain(row.domain) === saved.domain,
	);
}

/** One evidence row per field the judged row actually carried, so a null field records nothing rather than recording a null. */
export function evidenceRowsFor(
	saved: Company,
	row: CompanyRow,
): NewEvidence[] {
	const fields: Array<[string, string | null]> = [
		["name", row.name],
		["domain", row.domain],
		["linkedinUrl", row.linkedinUrl],
		["evidenceUrl", row.evidenceUrl],
		["signal", row.signal],
		["evidenceDate", row.evidenceDate],
	];
	return fields
		.filter((entry): entry is [string, string] => entry[1] !== null)
		.map(([kind, value]) => ({
			subjectType: "company",
			subjectId: saved.id,
			kind,
			value,
			source: EVIDENCE_SOURCE,
		}));
}
