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
import type { CompanyCapture } from "@/core/companies/candidates";
import { seedExcludedDomains } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type { RoundTiming } from "@/core/companies/rows";
import {
	assertUnderDailyCeiling,
	closeErroredRun,
	closeRun,
	loadIcp,
	openRun,
} from "@/core/db/queries";
import type { Requirement } from "@/core/requirements";
import type { IcpDoc } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";
import { roundDeps } from "@/workflows/find-companies-agent";
import type { RoundReport } from "@/workflows/find-companies-persist";
import {
	loadRequirements,
	persistCompanies,
	persistRound,
	reportRound,
	runRoundBody,
} from "@/workflows/find-companies-persist";

const MAX_ROUNDS = config.companies.maxRounds;

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

/** The options one round runs under, carrying the angles and reject reasons the rounds before it produced. */
type RoundOptionsInput = {
	payload: FindCompaniesPayload;
	organizationId: string;
	env: Env;
	today: string;
	history: { pastAngles: readonly string[]; feedback: readonly string[] };
	requirements: readonly Requirement[];
};

function roundOptions(input: RoundOptionsInput): FindCompaniesOptions {
	const { payload, organizationId, env, today, history } = input;
	return {
		icpId: payload.icpId,
		organizationId,
		env,
		today,
		requirements: input.requirements,
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
type CarriedAcross = {
	searches: FindCompaniesResult["searches"];
	captures: Record<string, CompanyCapture>;
	pages: FindCompaniesResult["pages"];
};

/** Moves one round's plans, vendor captures and retrieved pages onto the run's own lists, and returns the angles that round tried. */
function carried(result: FindCompaniesResult, across: CarriedAcross): string[] {
	across.searches.push(...result.searches);
	Object.assign(across.captures, result.captures);
	across.pages.push(...result.pages);
	return result.searches.map((plan) => plan.angle);
}

type RoundTarget = {
	env: Env;
	payload: FindCompaniesPayload;
	icp: IcpDoc;
	requirements: readonly Requirement[];
	runId: string;
	organizationId: string;
	step: WorkflowStep;
};

type RoundLoopState = {
	accumulatedDomains: Set<string>;
	searches: FindCompaniesResult["searches"];
	captures: Record<string, CompanyCapture>;
	pages: FindCompaniesResult["pages"];
	roundReports: RoundReport[];
	companies: CompanyRow[];
	rejects: FindCompaniesReject[];
	costDollars: number;
	rounds: number;
	lastRoundStatus: FindCompaniesStatus;
	pastAngles: string[];
	feedback: string[];
};

/** Runs one round as its own durable step and folds its result into the loop's state. Returns `"stop"` once the run has covered the market it can, or crossed its own spend ceiling. */
async function runOneRound(
	target: RoundTarget,
	state: RoundLoopState,
	round: number,
	today: string,
): Promise<"continue" | "stop"> {
	const { env, payload, icp, organizationId, step } = target;
	const opts = roundOptions({
		payload,
		organizationId,
		env,
		today,
		history: { pastAngles: state.pastAngles, feedback: state.feedback },
		requirements: target.requirements,
	});
	const timings: RoundTiming[] = [];
	const deps = roundDeps({
		accumulatedDomains: state.accumulatedDomains,
		step,
		round,
		today,
		seller: icp.seller,
		timings,
		runId: target.runId,
	});
	const remaining = payload.count - state.companies.length;
	const stepResult = await step.do(
		`round_${round}`,
		config.stepConfig.roundCall,
		() =>
			runRoundBody({
				env,
				step,
				runId: target.runId,
				round,
				alreadySpent: state.costDollars,
				icp,
				remaining,
				opts,
				deps,
			}),
	);
	state.companies = state.companies.concat(stepResult.companies);
	state.rejects = state.rejects.concat(stepResult.rejects);
	state.costDollars += stepResult.costDollars;
	state.rounds += 1;
	state.lastRoundStatus = stepResult.status;
	state.pastAngles = state.pastAngles.concat(
		carried(stepResult, {
			searches: state.searches,
			captures: state.captures,
			pages: state.pages,
		}),
	);
	state.feedback = stepResult.feedback;
	const report = reportRound(round, stepResult);
	state.roundReports.push(report);
	await persistRound({
		step,
		env,
		runId: target.runId,
		icpId: payload.icpId,
		costDollars: state.costDollars,
		result: stepResult,
		report,
		timings,
	});
	for (const domain of stepResult.seenDomains) {
		state.accumulatedDomains.add(domain);
	}
	if (stepResult.status === "exhausted") return "stop";
	if (state.costDollars >= config.spend.perRunDollars) {
		state.lastRoundStatus = "capped";
		return "stop";
	}
	return "continue";
}

async function runFindCompaniesRounds(
	target: {
		env: Env;
		payload: FindCompaniesPayload;
		icp: IcpDoc;
		requirements: readonly Requirement[];
		runId: string;
		organizationId: string;
		alreadySpent: number;
	},
	step: WorkflowStep,
): Promise<ReportedRounds> {
	const { payload, icp } = target;
	const today = await step.do("today", config.stepConfig.databaseCall, () =>
		Promise.resolve(new Date().toISOString().slice(0, 10)),
	);
	const state: RoundLoopState = {
		accumulatedDomains: seedExcludedDomains(
			payload.excludeDomains ?? [],
			icp.seller,
		),
		searches: [],
		captures: {},
		pages: [],
		roundReports: [],
		companies: [],
		rejects: [],
		costDollars: target.alreadySpent,
		rounds: 0,
		lastRoundStatus: "short",
		pastAngles: [],
		feedback: [],
	};

	for (
		let round = 1;
		round <= MAX_ROUNDS && state.companies.length < payload.count;
		round++
	) {
		const decision = await runOneRound(
			{ ...target, step },
			state,
			round,
			today,
		);
		if (decision === "stop") break;
	}

	return {
		companies: state.companies,
		requested: payload.count,
		found: state.companies.length,
		rounds: state.rounds,
		status: finalStatus(
			state.companies.length,
			payload.count,
			state.lastRoundStatus,
		),
		costDollars: state.costDollars,
		rejects: state.rejects,
		searches: state.searches,
		captures: state.captures,
		seenDomains: [...state.accumulatedDomains],
		feedback: state.feedback,
		pages: state.pages,
		roundReports: state.roundReports,
	};
}

/**
 * What the workflow reports back: counts, status, spend, the search plans,
 * and rejects. The row arrays and the vendor capture stay in Postgres, read
 * back a page at a time through `GET /runs/{runId}/companies`.
 */
type ReportedRounds = FindCompaniesResult & { roundReports: RoundReport[] };

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

export class FindCompaniesWorkflow extends WorkflowEntrypoint<
	Env,
	FindCompaniesPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<FindCompaniesPayload>>,
		step: WorkflowStep,
	): Promise<FindCompaniesSummary> {
		try {
			return await this.runToCompletion(event, step);
		} catch (error) {
			await step.do("close-errored", config.stepConfig.databaseCall, () =>
				closeErroredRun(this.env, event.instanceId),
			);
			throw error;
		}
	}

	private async runToCompletion(
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

		const requirements = await loadRequirements(
			this.env,
			step,
			payload.icpId,
			icp,
		);

		const result = await runFindCompaniesRounds(
			{
				env: this.env,
				payload,
				icp,
				requirements,
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
				pages: result.pages,
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
