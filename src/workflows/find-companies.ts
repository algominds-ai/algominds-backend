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
import type { CompanyCapture } from "@/core/companies/candidates";
import { toCompanyData } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { gate } from "@/core/companies/gate";
import { judge } from "@/core/companies/judge";
import {
	appendEvidence,
	closeRun,
	loadIcp,
	openRun,
	organizationSpendToday,
	recordRunSpend,
	saveCompanies,
	saveRound,
} from "@/core/db/queries";
import type { Company, NewCompany, NewEvidence } from "@/core/db/schema";
import { normalizeDomain } from "@/core/db/schema";
import { search } from "@/core/providers/exa/search";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";
import {
	agentRecentDomains,
	agentSearch,
	agentSynthesize,
} from "@/workflows/find-companies-agent";

const MAX_ROUNDS = config.companies.maxRounds;
const EVIDENCE_SOURCE = "exa";
/** One round refused seventy eight companies once. Enough of them to answer why, not all of them. */
const STORED_REJECTS_PER_ROUND = 120;

const FindCompaniesPayloadSchema = z.object({
	icpId: z.string(),
	count: z.number().int().positive(),
	excludeDomains: z.array(z.string().min(1)).optional(),
});

type FindCompaniesPayload = z.infer<typeof FindCompaniesPayloadSchema>;

type RoundDepsInput = {
	accumulatedDomains: ReadonlySet<string>;
	step: WorkflowStep;
	round: number;
	remaining: number;
	today: string;
};

function roundDeps(input: RoundDepsInput): FindCompaniesDeps {
	const { accumulatedDomains, step, round, remaining, today } = input;
	const lookupRecentDomains = agentRecentDomains(step, round);
	const viaAgent = agentSearch({ step, round, remaining, today });
	return {
		recentDomains: async (env, icpId, days) => {
			const known = await lookupRecentDomains(env, icpId, days);
			return [...known, ...accumulatedDomains];
		},
		synthesize: agentSynthesize(step, round),
		search: (plan, req, env, ledger) =>
			plan.source === "exa-agent"
				? viaAgent(plan, req, env, ledger)
				: search(req, env, ledger),
		gate,
		judge,
	};
}

/** A run that saved a company was never empty, whatever its last round reported. */
export function finalStatus(
	found: number,
	requested: number,
	lastRoundStatus: FindCompaniesStatus,
): FindCompaniesStatus {
	if (found >= requested) return "complete";
	if (lastRoundStatus === "capped") return "capped";
	if (lastRoundStatus === "empty") return found > 0 ? "short" : "empty";
	return lastRoundStatus === "exhausted" ? "exhausted" : "short";
}

type PersistRoundInput = {
	step: WorkflowStep;
	env: Env;
	runId: string;
	costDollars: number;
	result: FindCompaniesResult;
	report: RoundReport;
};

/** Banks what one round spent and what it did, in one durable step, so both land together or replay together. */
async function persistRound(input: PersistRoundInput): Promise<void> {
	const { step, env, runId, report } = input;
	await step.do(
		`round_${report.round}-spend`,
		config.stepConfig.databaseCall,
		async () => {
			await recordRunSpend(env, runId, input.costDollars);
			await saveRound(env, {
				runId,
				ordinal: report.round,
				plan: input.result.searches[0] ?? null,
				found: report.found,
				rejected: report.rejected,
				rejects: input.result.rejects.slice(0, STORED_REJECTS_PER_ROUND),
			});
		},
	);
}

/**
 * Runs up to three rounds, each in its own `step.do` for durability, and
 * merges their plain results into one `FindCompaniesResult`.
 */
async function runFindCompaniesRounds(
	target: {
		env: Env;
		payload: FindCompaniesPayload;
		icp: IcpDoc;
		runId: string;
	},
	step: WorkflowStep,
): Promise<ReportedRounds> {
	const { env, payload, icp, runId } = target;
	const today = await step.do("today", config.stepConfig.databaseCall, () =>
		Promise.resolve(new Date().toISOString().slice(0, 10)),
	);
	const accumulatedDomains = new Set(
		(payload.excludeDomains ?? []).map(normalizeDomain),
	);
	let companies: CompanyRow[] = [];
	let rejects: FindCompaniesReject[] = [];
	let costDollars = 0;
	let rounds = 0;
	const searches: FindCompaniesResult["searches"] = [];
	const captures: Record<string, CompanyCapture> = {};
	let lastRoundStatus: FindCompaniesStatus = "short";
	let pastAngles: string[] = [];
	let feedback: string[] = [];
	const roundReports: RoundReport[] = [];

	for (
		let round = 1;
		round <= MAX_ROUNDS && companies.length < payload.count;
		round++
	) {
		const remaining = payload.count - companies.length;
		const opts: FindCompaniesOptions = {
			icpId: payload.icpId,
			env,
			today,
			maxRounds: 1,
			pastAngles,
			feedback,
			excludeDomains: payload.excludeDomains ?? [],
		};
		const deps = roundDeps({
			accumulatedDomains,
			step,
			round,
			remaining,
			today,
		});
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
		const report = reportRound(round, stepResult);
		roundReports.push(report);
		lastRoundStatus = stepResult.status;
		await persistRound({
			step,
			env,
			runId,
			costDollars,
			result: stepResult,
			report,
		});
		for (const domain of stepResult.seenDomains) accumulatedDomains.add(domain);
		pastAngles = pastAngles.concat(
			stepResult.searches.map((plan) => plan.angle),
		);
		feedback = stepResult.feedback;
		if (stepResult.status === "exhausted") break;
		if (costDollars >= config.spend.perRunDollars) {
			lastRoundStatus = "capped";
			break;
		}
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
		seenDomains: [...accumulatedDomains],
		feedback,
		roundReports,
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
		linkedinUrl: row.linkedinUrl,
		industry: row.industry,
		data: toCompanyData(capture),
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

/**
 * What the workflow reports back: counts, status, spend, the search plans,
 * and rejects. The row arrays and the vendor capture stay in Postgres, read
 * back a page at a time through `GET /runs/{runId}/companies`.
 */
type ReportedRounds = FindCompaniesResult & { roundReports: RoundReport[] };

export type RoundReport = {
	round: number;
	angle: string;
	query: string;
	recency: string | null;
	recencyDays: number | null;
	source: string;
	type: string;
	agentEffort: string;
	additionalQueries: string[];
	found: number;
	rejected: { filter: number; gate: number; judge: number };
};

/** One line per round: the angle it tried, what it kept, and how many fell at each stage. The reasons themselves stay inside the run, since one round refused seventy eight companies and named every one. */
export function reportRound(
	round: number,
	result: FindCompaniesResult,
): RoundReport {
	const plan = result.searches[0];
	const count = (stage: FindCompaniesReject["stage"]): number =>
		result.rejects.filter((reject) => reject.stage === stage).length;
	return {
		round,
		angle: plan?.angle ?? "",
		query: plan?.query ?? "",
		recency: plan?.recency ?? null,
		recencyDays: plan?.recencyDays ?? null,
		source: plan?.source ?? "",
		type: plan?.type ?? "",
		agentEffort: plan?.agentEffort ?? "",
		additionalQueries: plan?.additionalQueries ?? [],
		found: result.companies.length,
		rejected: {
			filter: count("filter"),
			gate: count("gate"),
			judge: count("judge"),
		},
	};
}

export type FindCompaniesSummary = {
	requested: number;
	found: number;
	rounds: number;
	status: FindCompaniesStatus;
	costDollars: number;
	roundReports: RoundReport[];
};

function summarizeFindCompanies(result: ReportedRounds): FindCompaniesSummary {
	return {
		requested: result.requested,
		found: result.found,
		rounds: result.rounds,
		status: result.status,
		costDollars: result.costDollars,
		roundReports: result.roundReports,
	};
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
	): Promise<FindCompaniesSummary> {
		const payload = FindCompaniesPayloadSchema.parse(event.payload);
		const { doc: icp, organizationId } = await step.do(
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
					organizationId: icpRow.organizationId,
				};
			},
		);

		await step.do("open-run", config.stepConfig.databaseCall, async () => {
			const spent = await organizationSpendToday(this.env, organizationId);
			if (spent >= config.spend.perAccountDailyDollars) {
				throw new NonRetryableError(
					`daily ceiling reached for this account: ${spent} of ${config.spend.perAccountDailyDollars} dollars`,
				);
			}
			return openRun(this.env, {
				id: event.instanceId,
				organizationId,
				icpId: payload.icpId,
				capability: "companies",
				status: "running",
			});
		});

		const result = await runFindCompaniesRounds(
			{ env: this.env, payload, icp, runId: event.instanceId },
			step,
		);

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

		return summarizeFindCompanies(result);
	}
}
