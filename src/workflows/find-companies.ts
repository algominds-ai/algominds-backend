import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import type {
	FindCompaniesDeps,
	FindCompaniesOptions,
	FindCompaniesReject,
	FindCompaniesResult,
	FindCompaniesStatus,
} from "@/core/companies";
import { findCompanies } from "@/core/companies";
import type { CompanyCapture } from "@/core/company-candidates";
import { toCompanyData } from "@/core/company-candidates";
import {
	appendEvidence,
	closeRun,
	loadIcp,
	openRun,
	recentDomains,
	saveCompanies,
} from "@/core/db/queries";
import type { Company, NewCompany, NewEvidence } from "@/core/db/schema";
import { normalizeDomain } from "@/core/db/schema";
import type { CompanyRow } from "@/core/gate";
import { gate } from "@/core/gate";
import { judge } from "@/core/judge";
import { search } from "@/core/providers/exa";
import type { IcpDoc } from "@/core/synthesize";
import { IcpDocSchema, synthesize } from "@/core/synthesize";
import {
	agentRecentDomains,
	agentSearch,
	agentSynthesize,
} from "@/workflows/find-companies-agent";

const MAX_ROUNDS = config.companies.maxRounds;
const EVIDENCE_SOURCE = "exa";
const COMPANY_SOURCE: "exa-search" | "exa-agent" =
	config.companies.companySource;

const FindCompaniesPayloadSchema = z.object({
	icpId: z.string(),
	count: z.number().int().positive(),
});

type FindCompaniesPayload = z.infer<typeof FindCompaniesPayloadSchema>;

function roundDeps(
	accumulatedDomains: ReadonlySet<string>,
	step: WorkflowStep,
	round: number,
	remaining: number,
): FindCompaniesDeps {
	const isAgent = COMPANY_SOURCE === "exa-agent";
	const lookupRecentDomains = isAgent
		? agentRecentDomains(step, round)
		: recentDomains;
	return {
		recentDomains: async (env, icpId, days) => {
			const known = await lookupRecentDomains(env, icpId, days);
			return [...known, ...accumulatedDomains];
		},
		synthesize: isAgent ? agentSynthesize(step, round) : synthesize,
		search: isAgent ? agentSearch(step, round, remaining) : search,
		gate,
		judge,
	};
}

function trackDomains(
	domains: Set<string>,
	companies: readonly CompanyRow[],
	rejects: readonly FindCompaniesReject[],
): void {
	for (const company of companies) {
		if (company.domain) domains.add(normalizeDomain(company.domain));
	}
	for (const reject of rejects) {
		if (reject.domain) domains.add(normalizeDomain(reject.domain));
	}
}

function finalStatus(
	found: number,
	requested: number,
	lastRoundStatus: FindCompaniesStatus,
): FindCompaniesStatus {
	if (found >= requested) return "complete";
	return lastRoundStatus === "exhausted" ? "exhausted" : "short";
}

/**
 * Runs up to three rounds, each in its own `step.do` for durability, and
 * merges their plain results into one `FindCompaniesResult`.
 */
async function runFindCompaniesRounds(
	env: Env,
	payload: FindCompaniesPayload,
	icp: IcpDoc,
	step: WorkflowStep,
): Promise<FindCompaniesResult> {
	const accumulatedDomains = new Set<string>();
	let companies: CompanyRow[] = [];
	let rejects: FindCompaniesReject[] = [];
	let costDollars = 0;
	let rounds = 0;
	const searches: FindCompaniesResult["searches"] = [];
	const captures: Record<string, CompanyCapture> = {};
	let lastRoundStatus: FindCompaniesStatus = "short";

	for (
		let round = 1;
		round <= MAX_ROUNDS && companies.length < payload.count;
		round++
	) {
		const remaining = payload.count - companies.length;
		const opts: FindCompaniesOptions = {
			icpId: payload.icpId,
			env,
			maxRounds: 1,
		};
		const deps = roundDeps(accumulatedDomains, step, round, remaining);
		const stepResult = await step.do(
			`round_${round}`,
			config.stepConfig.paidCall,
			() => findCompanies(icp, remaining, opts, deps),
		);
		companies = companies.concat(stepResult.companies);
		rejects = rejects.concat(stepResult.rejects);
		costDollars += stepResult.costDollars;
		searches.push(...stepResult.searches);
		Object.assign(captures, stepResult.captures);
		rounds += 1;
		lastRoundStatus = stepResult.status;
		trackDomains(accumulatedDomains, stepResult.companies, stepResult.rejects);
		if (stepResult.status === "exhausted") break;
	}

	return {
		companies,
		requested: payload.count,
		found: companies.length,
		rounds,
		status: finalStatus(companies.length, payload.count, lastRoundStatus),
		costDollars,
		rejects,
		searches,
		captures,
	};
}

function toNewCompany(
	row: CompanyRow,
	icpId: string,
	runId: string,
	capture: CompanyCapture | undefined,
): NewCompany | null {
	if (row.name === null || row.domain === null || capture === undefined)
		return null;
	return {
		icpId,
		domain: row.domain,
		name: row.name,
		data: toCompanyData(capture, COMPANY_SOURCE),
		runId,
	};
}

function matchRow(
	rows: readonly CompanyRow[],
	saved: Company,
): CompanyRow | undefined {
	return rows.find(
		(row) =>
			row.domain !== null && normalizeDomain(row.domain) === saved.domain,
	);
}

function evidenceRowsFor(saved: Company, row: CompanyRow): NewEvidence[] {
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

type PersistCompaniesInput = {
	icpId: string;
	runId: string;
	companies: readonly CompanyRow[];
	captures: Record<string, CompanyCapture>;
};

async function persistCompanies(
	env: Env,
	input: PersistCompaniesInput,
): Promise<void> {
	const { icpId, runId, companies, captures } = input;
	const newCompanies = companies
		.map((row) =>
			toNewCompany(
				row,
				icpId,
				runId,
				row.domain ? captures[row.domain] : undefined,
			),
		)
		.filter((row): row is NewCompany => row !== null);
	const saved = await saveCompanies(env, newCompanies);
	const evidenceRows = saved.flatMap((company) => {
		const row = matchRow(companies, company);
		return row ? evidenceRowsFor(company, row) : [];
	});
	await appendEvidence(env, evidenceRows);
}

export class FindCompaniesWorkflow extends WorkflowEntrypoint<
	Env,
	FindCompaniesPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<FindCompaniesPayload>>,
		step: WorkflowStep,
	): Promise<FindCompaniesResult> {
		const payload = FindCompaniesPayloadSchema.parse(event.payload);
		const { doc: icp, accountId } = await step.do(
			"load-icp",
			config.stepConfig.databaseCall,
			async () => {
				const icpRow = await loadIcp(this.env, payload.icpId);
				if (!icpRow) {
					throw new NonRetryableError(
						`findCompanies: unknown icp ${payload.icpId}`,
					);
				}
				return {
					doc: IcpDocSchema.parse(icpRow.doc),
					accountId: icpRow.accountId,
				};
			},
		);

		await step.do("open-run", config.stepConfig.databaseCall, () =>
			openRun(this.env, {
				id: event.instanceId,
				accountId,
				icpId: payload.icpId,
				capability: "companies",
				status: "running",
			}),
		);

		const result = await runFindCompaniesRounds(this.env, payload, icp, step);

		await step.do("save-companies", config.stepConfig.databaseCall, () =>
			persistCompanies(this.env, {
				icpId: payload.icpId,
				runId: event.instanceId,
				companies: result.companies,
				captures: result.captures,
			}),
		);

		await step.do("close-run", config.stepConfig.databaseCall, () =>
			closeRun(this.env, event.instanceId, {
				status: result.status,
				costDollars: result.costDollars,
			}),
		);

		return result;
	}
}
