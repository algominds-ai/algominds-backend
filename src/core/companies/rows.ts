import type {
	CompanyCapture,
	FindCompaniesReject,
} from "@/core/companies/candidates";
import { toCompanyData } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type { EvidenceByRow } from "@/core/companies/judge-evidence";
import { judgedFields } from "@/core/companies/judge-evidence";
import type { Company, NewCompany, NewEvidence } from "@/core/db/schema";
import { normalizeDomain } from "@/core/db/schema";
import type { Requirement } from "@/core/requirements";
import {
	evidenceDemandConditions,
	requiredConditionRefs,
} from "@/core/requirements";

const EVIDENCE_SOURCE = "exa";
const ENGINE_SOURCE = "engine";
const RAW_RESULT_MAX_CHARS = 20_000;
const PAGE_TEXT_MAX_CHARS = 10_000;
const ROUND_REFUSALS_MAX_CHARS = 20_000;

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

function boundedRaw(json: string): string {
	return json.length > RAW_RESULT_MAX_CHARS
		? json.slice(0, RAW_RESULT_MAX_CHARS)
		: json;
}

/** One append-only evidence row carrying the vendor's raw result for a kept company, unshaped and bounded to `RAW_RESULT_MAX_CHARS`. `agent-result` names a row an agent round produced; every other round names it `search-result`. */
export function rawResultEvidenceRow(
	saved: Company,
	capture: CompanyCapture,
): NewEvidence {
	return {
		subjectType: "company",
		subjectId: saved.id,
		kind: capture.source === "exa-agent" ? "agent-result" : "search-result",
		value: boundedRaw(capture.raw),
		source: EVIDENCE_SOURCE,
	};
}

/** One append-only evidence row carrying the text of a page a round retrieved to prove a requirement, bounded to `PAGE_TEXT_MAX_CHARS`, so the content the decision rested on is stored rather than discarded. */
export function retrievedPageEvidenceRow(
	saved: Company,
	page: { url: string; text: string },
): NewEvidence {
	return {
		subjectType: "company",
		subjectId: saved.id,
		kind: "proving-page",
		value: `${page.url}\n${page.text.slice(0, PAGE_TEXT_MAX_CHARS)}`,
		source: EVIDENCE_SOURCE,
	};
}

type RefusedRow = {
	domain: string | null;
	reason: string;
	statuses: { id: string; status: string }[];
};

function refusedRow(reject: FindCompaniesReject): RefusedRow | null {
	if (reject.statuses === undefined) return null;
	return {
		domain: reject.domain,
		reason: reject.reason,
		statuses: reject.statuses,
	};
}

export type StartedAgentRun = { id: string; angle: string; effort: string };

/** One append-only evidence row recording an Exa agent run the moment it starts, so a poll failure later in the round still leaves the run id behind for vendor-cost reconciliation. */
export function agentRunEvidenceRow(
	runId: string,
	started: StartedAgentRun,
): NewEvidence {
	return {
		subjectType: "run",
		subjectId: runId,
		kind: "agent-run",
		value: JSON.stringify(started),
		source: EVIDENCE_SOURCE,
	};
}

export type RoundTiming = { dep: string; seconds: number };

/** One append-only evidence row per round carrying the seconds each dependency spent, so a slow round can be attributed to its search, proof or judge; null when nothing was timed. */
export function roundTimingsEvidenceRow(
	runId: string,
	round: number,
	timings: readonly RoundTiming[],
): NewEvidence | null {
	if (timings.length === 0) return null;
	return {
		subjectType: "run",
		subjectId: runId,
		kind: "round-timings",
		value: JSON.stringify({ runId, round, timings }),
		source: EVIDENCE_SOURCE,
	};
}

/** One append-only evidence row per round carrying every row the judge refused, with its domain, reason and statuses, bounded to `ROUND_REFUSALS_MAX_CHARS`; null when the round refused nothing. */
export function roundRefusalsEvidenceRow(
	runId: string,
	round: number,
	rejects: readonly FindCompaniesReject[],
): NewEvidence | null {
	const refused = rejects
		.map(refusedRow)
		.filter((row): row is RefusedRow => row !== null);
	if (refused.length === 0) return null;
	const value = JSON.stringify({ runId, round, refused });
	return {
		subjectType: "run",
		subjectId: runId,
		kind: "round-refusals",
		value: value.slice(0, ROUND_REFUSALS_MAX_CHARS),
		source: EVIDENCE_SOURCE,
	};
}

type JudgeRequirementFlag = { id: string; quoteRequired: boolean };

/** Every hard requirement the judge was told about, each carrying whether that requirement needed a quote for a `proven` status. */
function judgeRequirementFlags(
	requirements: readonly Requirement[],
): JudgeRequirementFlag[] {
	const grounded = new Set(
		evidenceDemandConditions(requirements).map((req) => req.id),
	);
	return requiredConditionRefs(requirements).map((req) => ({
		id: req.id,
		quoteRequired: grounded.has(req.id),
	}));
}

export type JudgeInputRowsInput = {
	runId: string;
	round: number;
	rows: readonly CompanyRow[];
	evidenceByRow: EvidenceByRow;
	requirements: readonly Requirement[];
};

/**
 * One append-only evidence row per row the judge is about to see, carrying
 * the exact fields, page evidence and requirement list the model call reads,
 * so a later replay can reproduce that call byte for byte.
 */
export function judgeInputEvidenceRows(
	input: JudgeInputRowsInput,
): NewEvidence[] {
	const { runId, round, rows, evidenceByRow, requirements } = input;
	const requirementFlags = judgeRequirementFlags(requirements);
	return rows.map((row, index) => {
		const evidence = evidenceByRow.get(index);
		return {
			subjectType: "run",
			subjectId: runId,
			kind: "judge-input",
			value: JSON.stringify({
				round,
				domain: row.domain,
				fields: judgedFields(row, evidence),
				evidence: evidence ? Object.fromEntries(evidence) : null,
				requirements: requirementFlags,
			}),
			source: ENGINE_SOURCE,
		};
	});
}
