import type { ApiClient } from "@eval/api-client";
import {
	startCompaniesRun,
	startPeopleRun,
	waitForRunTerminal,
} from "@eval/api-client";
import type { SeededTrial } from "@eval/arm-db";
import type { EngineScore } from "@eval/engine-score";
import { computeEngineScore } from "@eval/engine-score";
import { computeVerdict, type StoredCompanyRecord } from "@eval/headline";
import { readKeyFile, readPeopleKeyFile } from "@eval/keys-io";
import type { KeyFile } from "@eval/label-core";
import {
	computePeopleVerdict,
	type PeopleVerdict,
	type StoredPersonRecord,
} from "@eval/people-headline";
import type { PeopleKeyFile } from "@eval/people-key";
import { fetchRunCompanies, fetchRunPeople } from "@eval/people-run";
import type { Profile, ProfileBars } from "@eval/profiles";
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
import type {
	ScoredCompanyRow,
	ScoredPersonRow,
	TrialOutput,
} from "@eval/scorers";
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

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		scoredCompanies: [],
		scoredPeople: [],
	};
}

function scoredCompanyRows(
	key: KeyFile,
	stored: readonly StoredCompanyRecord[],
): ScoredCompanyRow[] {
	return stored.map((row) => ({
		domain: row.domain,
		label: key.companies[row.domain]?.label ?? null,
	}));
}

function scoredPersonRows(
	peopleKey: PeopleKeyFile,
	people: readonly StoredPersonRecord[],
): ScoredPersonRow[] {
	return people.map((person) => ({
		linkedinUrl: person.linkedinUrl,
		company: person.company,
		label:
			person.linkedinUrl === null
				? null
				: (peopleKey.people[person.linkedinUrl]?.label ?? null),
	}));
}

type RunContext = { client: ApiClient; sql: postgres.Sql };

type StageContext = { context: RunContext; trial: TrialCase; profile: Profile };

export type CompaniesStageResult = {
	companiesRunId: string;
	companiesStatus: string;
	companiesCostDollars: number;
	companiesStartedAt: string;
	companiesFinishedAt: string | null;
	storedCompanies: readonly StoredCompanyRecord[];
	key: KeyFile;
	companyGates: {
		noKeyRejectedStored: boolean;
		noDuplicateOrganisationGroup: boolean;
		provingPassesWhereRequired: boolean;
	};
};

async function runCompaniesStage(
	stage: StageContext,
	count: number,
): Promise<CompaniesStageResult> {
	const { client, sql } = stage.context;
	const { trial, profile } = stage;
	const companiesRunId = await startCompaniesRun(client, trial.icpId, count);
	await waitForRunTerminal(client, companiesRunId);
	const companiesRun = await readRunReport(sql, companiesRunId);
	const companiesStatus = await readRunStatus(sql, companiesRunId);
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
	return {
		companiesRunId,
		companiesStatus,
		companiesCostDollars: companiesRun.costDollars,
		companiesStartedAt: companiesRun.startedAt,
		companiesFinishedAt: companiesRun.finishedAt,
		storedCompanies,
		key,
		companyGates: {
			noKeyRejectedStored: companyVerdict.gates.noKeyRejectedStored,
			noDuplicateOrganisationGroup:
				companyVerdict.gates.noDuplicateOrganisationGroup,
			provingPassesWhereRequired:
				companyVerdict.gates.provingPassesWhereRequired,
		},
	};
}

export type PeopleStageResult = {
	peopleRunId: string | null;
	peopleStatus: string | null;
	peopleCostDollars: number;
	peopleFinishedAt: string | null;
	deliveredPeople: readonly StoredPersonRecord[];
	peopleKey: PeopleKeyFile;
	peopleVerdict: PeopleVerdict | null;
};

function emptyPeopleStage(peopleKey: PeopleKeyFile): PeopleStageResult {
	return {
		peopleRunId: null,
		peopleStatus: null,
		peopleCostDollars: 0,
		peopleFinishedAt: null,
		deliveredPeople: [],
		peopleKey,
		peopleVerdict: null,
	};
}

/** Runs `/people/find` for `domains` and scores it, or reports an empty stage at zero cost when there are no domains — `startPeopleRun` is never called on an empty list. */
async function runPeopleStage(
	stage: StageContext,
	domains: readonly string[],
): Promise<PeopleStageResult> {
	const { client, sql } = stage.context;
	const { trial, profile } = stage;
	const peopleKey = readPeopleKeyFile(profile.slug, profile.icpId);
	if (domains.length === 0) return emptyPeopleStage(peopleKey);
	const peopleRunId = await startPeopleRun(client, trial.icpId, domains);
	await waitForRunTerminal(client, peopleRunId);
	const peopleRun = await readRunReport(sql, peopleRunId);
	const peopleStatus = await readRunStatus(sql, peopleRunId);
	const runCompanies = await fetchRunCompanies(sql, peopleRunId);
	const deliveredPeople = await fetchRunPeople(sql, peopleRunId);
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
	return {
		peopleRunId,
		peopleStatus,
		peopleCostDollars: peopleRun.costDollars,
		peopleFinishedAt: peopleRun.finishedAt,
		deliveredPeople,
		peopleKey,
		peopleVerdict,
	};
}

export function scoreTrial(
	profile: Profile,
	count: number,
	companies: CompaniesStageResult,
	people: PeopleStageResult,
): TrialOutput {
	const totalCostDollars =
		companies.companiesCostDollars + people.peopleCostDollars;
	const endedAt = people.peopleFinishedAt ?? companies.companiesFinishedAt;
	const totalSeconds = totalWallSeconds(companies.companiesStartedAt, endedAt);
	const engine: EngineScore = computeEngineScore({
		key: companies.key,
		peopleKey: people.peopleKey,
		companyGates: companies.companyGates,
		companiesStatus: companies.companiesStatus,
		peopleStatus: people.peopleStatus,
		peopleGatesPass: people.peopleVerdict
			? people.peopleVerdict.gates.runCompleted &&
				people.peopleVerdict.gates.noKeyRejectedStored &&
				people.peopleVerdict.gates.everyoneReachable
			: null,
		storedCompanies: companies.storedCompanies,
		deliveredPeople: people.deliveredPeople,
		requested: count,
		totalCostDollars,
		totalSeconds,
		bars: profile.fullChainBars,
	});
	return {
		engine,
		companiesRunId: companies.companiesRunId,
		peopleRunId: people.peopleRunId,
		peopleVerdict: people.peopleVerdict,
		totalCostDollars,
		totalSeconds,
		skipped: null,
		scoredCompanies: scoredCompanyRows(
			companies.key,
			companies.storedCompanies,
		),
		scoredPeople: scoredPersonRows(people.peopleKey, people.deliveredPeople),
	};
}

/** Starts and waits out a companies run, then a people run over the domains it stored, scores both against their keys, and folds the two into one engine score. Banks each stage's cost as soon as that stage finishes, and turns a crash after the companies stage into an incomplete-but-informative output rather than losing what already ran. */
async function runOneTrial(
	context: RunContext,
	trial: TrialCase,
	count: number,
	bankStage: (dollars: number) => void,
): Promise<TrialOutput> {
	const profile = profileBySlug(trial.slug);
	if (!profile) throw new Error(`eval: unknown profile ${trial.slug}`);
	const stage: StageContext = { context, trial, profile };
	let companies: CompaniesStageResult;
	try {
		companies = await runCompaniesStage(stage, count);
	} catch (error) {
		return emptyTrialOutput(`companies stage failed: ${describeError(error)}`);
	}
	bankStage(companies.companiesCostDollars);
	try {
		const domains = companies.storedCompanies.map((row) => row.domain);
		const people = await runPeopleStage(stage, domains);
		bankStage(people.peopleCostDollars);
		return scoreTrial(profile, count, companies, people);
	} catch (error) {
		return {
			engine: null,
			companiesRunId: companies.companiesRunId,
			peopleRunId: null,
			peopleVerdict: null,
			totalCostDollars: companies.companiesCostDollars,
			totalSeconds: null,
			skipped: `people stage failed: ${describeError(error)}`,
			scoredCompanies: scoredCompanyRows(
				companies.key,
				companies.storedCompanies,
			),
			scoredPeople: [],
		};
	}
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

/** One trial's task: skip it without spending anything once the budget blocks it, otherwise start, wait, read back and score the full chain, banking each stage's cost as it lands. */
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
		const bankStage = (dollars: number) =>
			bankSpend(budget, trial.slug, dollars);
		const output = await runOneTrial(
			{ client, sql },
			trial,
			input.count,
			bankStage,
		);
		fillMetadata(hooks, output);
		return output;
	};
}
