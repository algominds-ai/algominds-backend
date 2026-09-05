import type { ApiClient } from "@eval/api-client";
import {
	startCompaniesRun,
	startPeopleRun,
	waitForRunTerminal,
} from "@eval/api-client";
import type { SeededTrial } from "@eval/arm-db";
import type { EngineScore } from "@eval/engine-score";
import { computeEngineScore } from "@eval/engine-score";
import { computeVerdict } from "@eval/headline";
import { readKeyFile, readPeopleKeyFile } from "@eval/keys-io";
import { computePeopleVerdict } from "@eval/people-headline";
import { fetchRunCompanies, fetchRunPeople } from "@eval/people-run";
import type { ProfileBars } from "@eval/profiles";
import {
	MAX_PROFILE_SPEND_DOLLARS,
	MAX_SPEND_DOLLARS,
	profileBySlug,
} from "@eval/profiles";
import {
	readRequiresProvingPass,
	readRunReport,
	readRunStatus,
	readStoredCompanies,
} from "@eval/read";
import type { TrialOutput } from "@eval/scorers";
import type { EvalHooks, EvalParameters } from "braintrust";
import type postgres from "postgres";

export type TrialCase = SeededTrial & { bars: ProfileBars };

/** The seeded trials with each profile's bars, scaled by `scale` so a request larger than the default keeps proportional cost and time bars. */
export function casesFor(
	seeded: readonly SeededTrial[],
	scale = 1,
): TrialCase[] {
	return seeded.map((trial) => {
		const profile = profileBySlug(trial.slug);
		if (!profile) throw new Error(`eval: unknown profile ${trial.slug}`);
		const bars: ProfileBars = {
			maxCostDollars: profile.bars.maxCostDollars * scale,
			maxSeconds: profile.bars.maxSeconds * scale,
		};
		return { ...trial, bars };
	});
}

export type SanitizedInput = {
	slug: string;
	trialIndex: number;
	count: number;
};

export function sanitizedInputFor(
	trial: TrialCase,
	count: number,
): SanitizedInput {
	return { slug: trial.slug, trialIndex: trial.trialIndex, count };
}

function caseKey(slug: string, trialIndex: number): string {
	return `${slug}:${trialIndex}`;
}

export type Budget = {
	spent: number;
	perProfile: Record<string, number>;
	profileCap: number;
};

export function newBudget(slugs: readonly string[], scale = 1): Budget {
	return {
		spent: 0,
		profileCap: MAX_PROFILE_SPEND_DOLLARS * scale,
		perProfile: Object.fromEntries(slugs.map((slug) => [slug, 0])),
	};
}

export function budgetBlock(budget: Budget, slug: string): string | null {
	if (budget.spent >= MAX_SPEND_DOLLARS) {
		return `total spend $${budget.spent.toFixed(2)} at the $${MAX_SPEND_DOLLARS} cap`;
	}
	const spentOnProfile = budget.perProfile[slug] ?? 0;
	if (spentOnProfile >= budget.profileCap) {
		return `${slug} spend $${spentOnProfile.toFixed(2)} at the $${budget.profileCap} per-profile cap`;
	}
	return null;
}

function bankSpend(budget: Budget, slug: string, cost: number): void {
	budget.spent += cost;
	budget.perProfile[slug] = (budget.perProfile[slug] ?? 0) + cost;
}

function totalWallSeconds(
	startedAt: string,
	finishedAt: string | null,
): number | null {
	if (!finishedAt) return null;
	return (
		(new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000
	);
}

function emptyTrialOutput(skipped: string): TrialOutput {
	return {
		engine: null,
		companiesRunId: null,
		peopleRunId: null,
		peopleVerdict: null,
		totalCostDollars: 0,
		totalSeconds: null,
		skipped,
	};
}

/** Starts and waits out a companies run, then a people run over the domains it stored, scores both against their keys, and folds the two into one engine score. */
async function runOneTrial(
	client: ApiClient,
	sql: postgres.Sql,
	trial: TrialCase,
	count: number,
): Promise<TrialOutput> {
	const profile = profileBySlug(trial.slug);
	if (!profile) throw new Error(`eval: unknown profile ${trial.slug}`);
	const companiesRunId = await startCompaniesRun(client, trial.icpId, count);
	await waitForRunTerminal(client, companiesRunId);
	const companiesRun = await readRunReport(sql, companiesRunId);
	const storedCompanies = await readStoredCompanies(sql, companiesRunId);
	const requiresProvingPass = await readRequiresProvingPass(sql, trial.icpId);
	const key = readKeyFile(profile.slug, profile.icpId);
	const companyVerdict = computeVerdict({
		key,
		run: companiesRun,
		bars: trial.bars,
		requiresProvingPass,
		stored: storedCompanies,
	});

	const domains = storedCompanies.map((row) => row.domain);
	const peopleRunId = await startPeopleRun(client, trial.icpId, domains);
	await waitForRunTerminal(client, peopleRunId);
	const peopleRun = await readRunReport(sql, peopleRunId);
	const peopleStatus = await readRunStatus(sql, peopleRunId);
	const runCompanies = await fetchRunCompanies(sql, peopleRunId);
	const deliveredPeople = await fetchRunPeople(sql, peopleRunId);
	const peopleKey = readPeopleKeyFile(profile.slug, profile.icpId);
	const peopleVerdict = computePeopleVerdict({
		key: peopleKey,
		run: {
			runId: peopleRunId,
			status: peopleStatus,
			costDollars: peopleRun.costDollars,
		},
		companies: runCompanies,
		people: deliveredPeople,
		bars: {
			maxCostDollars: profile.bars.maxCostDollars,
			countries: profile.countries,
		},
	});

	const totalCostDollars = companiesRun.costDollars + peopleRun.costDollars;
	const totalSeconds = totalWallSeconds(
		companiesRun.startedAt,
		peopleRun.finishedAt,
	);
	const engine: EngineScore = computeEngineScore({
		key,
		peopleKey,
		companyGates: {
			noKeyRejectedStored: companyVerdict.gates.noKeyRejectedStored,
			noDuplicateOrganisationGroup:
				companyVerdict.gates.noDuplicateOrganisationGroup,
			provingPassesWhereRequired:
				companyVerdict.gates.provingPassesWhereRequired,
		},
		storedCompanies,
		deliveredPeople,
		requested: count,
		totalCostDollars,
		totalSeconds,
		bars: trial.bars,
	});
	return {
		engine,
		companiesRunId,
		peopleRunId,
		peopleVerdict,
		totalCostDollars,
		totalSeconds,
		skipped: null,
	};
}

export type TrialMetadata = {
	companiesRunId: string | null;
	peopleRunId: string | null;
	costDollars: number;
	seconds: number | null;
	acceptedPerDollar: number;
	acceptedPerMinute: number;
};

export function emptyTrialMetadata(): TrialMetadata {
	return {
		companiesRunId: null,
		peopleRunId: null,
		costDollars: 0,
		seconds: null,
		acceptedPerDollar: 0,
		acceptedPerMinute: 0,
	};
}

function fillMetadata(
	hooks: EvalHooks<void, TrialMetadata, EvalParameters>,
	output: TrialOutput,
): void {
	hooks.metadata.companiesRunId = output.companiesRunId;
	hooks.metadata.peopleRunId = output.peopleRunId;
	hooks.metadata.costDollars = output.totalCostDollars;
	hooks.metadata.seconds = output.totalSeconds;
	hooks.metadata.acceptedPerDollar = output.engine?.acceptedPerDollar ?? 0;
	hooks.metadata.acceptedPerMinute = output.engine?.acceptedPerMinute ?? 0;
}

/** One trial's task: skip it without spending anything once the budget blocks it, otherwise start, wait, read back and score the full chain, banking what it actually cost. */
export function buildTask(
	apiUrl: string,
	sql: postgres.Sql,
	budget: Budget,
	cases: readonly TrialCase[],
) {
	const byKey = new Map(
		cases.map((trial) => [caseKey(trial.slug, trial.trialIndex), trial]),
	);
	return async (
		input: SanitizedInput,
		hooks: EvalHooks<void, TrialMetadata, EvalParameters>,
	): Promise<TrialOutput> => {
		const trial = byKey.get(caseKey(input.slug, input.trialIndex));
		if (!trial) {
			throw new Error(
				`eval: no seeded trial for ${input.slug} t${input.trialIndex}`,
			);
		}
		const blocked = budgetBlock(budget, trial.slug);
		if (blocked) return emptyTrialOutput(blocked);
		const client: ApiClient = { baseUrl: apiUrl, apiKey: trial.apiKey };
		const output = await runOneTrial(client, sql, trial, input.count);
		bankSpend(budget, trial.slug, output.totalCostDollars);
		fillMetadata(hooks, output);
		return output;
	};
}
