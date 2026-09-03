import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import type {
	FindCompaniesOptions,
	FindCompaniesReject,
	FindCompaniesResult,
	FindCompaniesStatus,
} from "@/core/companies";
import { findCompanies } from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import {
	seedExcludedDomains,
	toCompanyData,
} from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { evidenceRowsFor, matchRow, toNewCompany } from "@/core/companies/rows";
import {
	appendEvidence,
	assertUnderDailyCeiling,
	closeRun,
	loadIcp,
	openRun,
	recordRunSpend,
	saveCompanies,
	saveRound,
} from "@/core/db/queries";
import type { Company, NewCompany, NewEvidence } from "@/core/db/schema";
import { normalizeDomain } from "@/core/db/schema";
import type { IcpDoc } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";
import { roundDeps } from "@/workflows/find-companies-agent";

const MAX_ROUNDS = config.companies.maxRounds;
/** One round refused seventy eight companies once. Enough of them to answer why, not all of them. */
const STORED_REJECTS_PER_ROUND = 120;

const FindCompaniesPayloadSchema = z.object({
	icpId: z.string(),
	count: z.number().int().positive(),
	excludeDomains: z.array(z.string().min(1)).optional(),
});

type FindCompaniesPayload = z.infer<typeof FindCompaniesPayloadSchema>;

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

/** The options one round runs under, carrying the angles and reject reasons the rounds before it produced. */
type RoundOptionsInput = {
	payload: FindCompaniesPayload;
	organizationId: string;
	env: Env;
	today: string;
	history: { pastAngles: readonly string[]; feedback: readonly string[] };
};

function roundOptions(input: RoundOptionsInput): FindCompaniesOptions {
	const { payload, organizationId, env, today, history } = input;
	return {
		icpId: payload.icpId,
		organizationId,
		env,
		today,
		maxRounds: 1,
		pastAngles: history.pastAngles,
		feedback: history.feedback,
		excludeDomains: payload.excludeDomains ?? [],
	};
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
		organizationId: string;
		alreadySpent: number;
	},
	step: WorkflowStep,
): Promise<ReportedRounds> {
	const { env, payload, icp, runId, organizationId } = target;
	const today = await step.do("today", config.stepConfig.databaseCall, () =>
		Promise.resolve(new Date().toISOString().slice(0, 10)),
	);
	const accumulatedDomains = seedExcludedDomains(
		payload.excludeDomains ?? [],
		icp.seller,
	);
	let companies: CompanyRow[] = [];
	let rejects: FindCompaniesReject[] = [];
	let costDollars = target.alreadySpent;
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
		const opts = roundOptions({
			payload,
			organizationId,
			env,
			today,
			history: { pastAngles, feedback },
		});
		const deps = roundDeps({
			accumulatedDomains,
			step,
			round,
			remaining,
			today,
			seller: icp.seller,
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
	eventWindowDays: number | null;
	recencyDays: number | null;
	source: string;
	agentEffort: string;
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
		eventWindowDays: plan?.eventWindowDays ?? null,
		recencyDays: plan?.recencyDays ?? null,
		source: plan?.source ?? "",
		agentEffort: plan?.agentEffort ?? "",
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
	organizationId: string;
	companies: readonly CompanyRow[];
	captures: Record<string, CompanyCapture>;
};

async function persistCompanies(
	env: Env,
	input: PersistCompaniesInput,
): Promise<void> {
	const { icpId, runId, organizationId, companies, captures } = input;
	const newCompanies = companies
		.map((row) =>
			toNewCompany(
				row,
				{ icpId, runId, organizationId },
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

		const alreadySpent = await step.do(
			"open-run",
			config.stepConfig.databaseCall,
			async () => {
				await assertUnderDailyCeiling(this.env, organizationId);
				const row = await openRun(this.env, {
					id: event.instanceId,
					organizationId,
					icpId: payload.icpId,
					capability: "companies",
					status: "running",
				});
				return { alreadySpent: row.costDollars };
			},
		);

		const result = await runFindCompaniesRounds(
			{
				env: this.env,
				payload,
				icp,
				runId: event.instanceId,
				organizationId,
				alreadySpent: alreadySpent.alreadySpent,
			},
			step,
		);

		await step.do("save-companies", config.stepConfig.databaseCall, () =>
			persistCompanies(this.env, {
				icpId: payload.icpId,
				runId: event.instanceId,
				organizationId,
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
