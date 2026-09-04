import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ApiClient } from "@eval/api-client";
import { startCompaniesRun, waitForRunTerminal } from "@eval/api-client";
import type { SeededTrial } from "@eval/arm-db";
import { bootstrapArmSchema, seedArmProfiles } from "@eval/arm-db";
import { openKeyDataset, syncKeyDataset } from "@eval/datasets";
import { startDevServer } from "@eval/dev-server";
import { computeVerdict } from "@eval/headline";
import { readKeyFile } from "@eval/keys-io";
import type { KeyFile } from "@eval/label-core";
import { buildManifest } from "@eval/manifest";
import type { ProfileBars } from "@eval/profiles";
import {
	COMPANIES_PER_RUN,
	MAX_PROFILE_SPEND_DOLLARS,
	MAX_SPEND_DOLLARS,
	MIN_TRIALS,
	type PROFILES,
	profileBySlug,
	profilesFor,
} from "@eval/profiles";
import {
	readRequiresProvingPass,
	readRunReport,
	readStoredCompanies,
} from "@eval/read";
import type { TrialOutput } from "@eval/scorers";
import { CODE_SCORERS } from "@eval/scorers";
import type { RunTraceMeta } from "@eval/trace";
import {
	attachTraceToCurrentSpan,
	logTrace,
	traceCompaniesRun,
} from "@eval/trace";
import { Eval } from "braintrust";
import postgres from "postgres";

const DEV_SERVER_PORT = 8787;

export type RunArgs = { profile: string | null; arm: string; trials: number };

function flagValue(argv: readonly string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index === -1 ? null : (argv[index + 1] ?? null);
}

export function parseArgs(argv: readonly string[]): RunArgs {
	const profile = flagValue(argv, "--profile");
	const arm = flagValue(argv, "--arm") ?? "baseline";
	const trialsArg = flagValue(argv, "--trials");
	const trials = trialsArg ? Number.parseInt(trialsArg, 10) : MIN_TRIALS;
	if (!Number.isInteger(trials) || trials < MIN_TRIALS) {
		throw new Error(`eval: --trials must be an integer at least ${MIN_TRIALS}`);
	}
	return { profile, arm, trials };
}

export function selectedProfiles(
	slug: string | null,
): readonly (typeof PROFILES)[number][] {
	return profilesFor(slug);
}

export type Budget = { spent: number; perProfile: Record<string, number> };

export function newBudget(slugs: readonly string[]): Budget {
	return {
		spent: 0,
		perProfile: Object.fromEntries(slugs.map((slug) => [slug, 0])),
	};
}

export function budgetBlock(budget: Budget, slug: string): string | null {
	if (budget.spent >= MAX_SPEND_DOLLARS) {
		return `total spend $${budget.spent.toFixed(2)} at the $${MAX_SPEND_DOLLARS} cap`;
	}
	const spentOnProfile = budget.perProfile[slug] ?? 0;
	if (spentOnProfile >= MAX_PROFILE_SPEND_DOLLARS) {
		return `${slug} spend $${spentOnProfile.toFixed(2)} at the $${MAX_PROFILE_SPEND_DOLLARS} per-profile cap`;
	}
	return null;
}

function bankSpend(budget: Budget, slug: string, cost: number): void {
	budget.spent += cost;
	budget.perProfile[slug] = (budget.perProfile[slug] ?? 0) + cost;
}

function gitCommit(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

async function syncDatasetsFor(
	profiles: typeof PROFILES,
): Promise<Record<string, string | null>> {
	const snapshotIds: Record<string, string | null> = {};
	for (const profile of profiles) {
		const key = readKeyFile(profile.slug, profile.icpId);
		const synced = await syncKeyDataset(openKeyDataset(profile.slug), key);
		snapshotIds[profile.slug] = synced.version;
	}
	return snapshotIds;
}

export type TrialCase = SeededTrial & { bars: ProfileBars };

export function casesFor(seeded: readonly SeededTrial[]): TrialCase[] {
	return seeded.map((trial) => {
		const profile = profileBySlug(trial.slug);
		if (!profile) throw new Error(`eval: unknown profile ${trial.slug}`);
		return { ...trial, bars: profile.bars };
	});
}

type TrialResult = TrialOutput & { costDollars: number };

type ArmIdentity = { arm: string; commit: string };
type TrialKey = { trial: TrialCase; key: KeyFile };

/**
 * Logs one trial's Braintrust trace, best-effort: a trace failure never
 * fails the trial it describes. Attaches the same span tree, with every
 * code scorer's score, onto the current experiment span, and separately
 * logs it to project logs so the run is also browsable outside any one
 * experiment.
 */
async function traceTrial(
	sql: postgres.Sql,
	runId: string,
	trialKey: TrialKey,
	identity: ArmIdentity,
): Promise<void> {
	const { trial, key } = trialKey;
	const meta: RunTraceMeta = {
		profile: trial.slug,
		arm: identity.arm,
		trial: trial.trialIndex,
		commit: identity.commit,
	};
	try {
		const spec = await traceCompaniesRun(
			sql,
			runId,
			{ icpId: trial.icpId, key },
			meta,
		);
		attachTraceToCurrentSpan(spec);
		await logTrace(spec);
	} catch (error) {
		console.error(`eval: trace failed for ${runId}: ${String(error)}`);
	}
}

async function runOneTrial(
	client: ApiClient,
	sql: postgres.Sql,
	trial: TrialCase,
	identity: ArmIdentity,
): Promise<TrialResult> {
	const runId = await startCompaniesRun(client, trial.icpId, COMPANIES_PER_RUN);
	await waitForRunTerminal(client, runId);
	const run = await readRunReport(sql, runId);
	const stored = await readStoredCompanies(sql, runId);
	const requiresProvingPass = await readRequiresProvingPass(sql, trial.icpId);
	const profile = profileBySlug(trial.slug);
	if (!profile) throw new Error(`eval: unknown profile ${trial.slug}`);
	const key = readKeyFile(profile.slug, profile.icpId);
	const verdict = computeVerdict({
		key,
		run,
		bars: trial.bars,
		requiresProvingPass,
		stored,
	});
	await traceTrial(sql, runId, { trial, key }, identity);
	return { verdict, runId, skipped: null, costDollars: run.costDollars };
}

/** One trial's task: skip it without spending anything once the budget blocks it, otherwise start, wait, read back and score it, banking what it actually cost. */
function buildTask(
	apiUrl: string,
	sql: postgres.Sql,
	budget: Budget,
	identity: ArmIdentity,
) {
	return async (trial: TrialCase): Promise<TrialOutput> => {
		const blocked = budgetBlock(budget, trial.slug);
		if (blocked) return { verdict: null, runId: null, skipped: blocked };
		const client: ApiClient = { baseUrl: apiUrl, apiKey: trial.apiKey };
		const result = await runOneTrial(client, sql, trial, identity);
		bankSpend(budget, trial.slug, result.costDollars);
		return { verdict: result.verdict, runId: result.runId, skipped: null };
	};
}

type ArmSetup = { seeded: SeededTrial[]; apiUrl: string; stop: () => void };

async function setUpArm(arm: string, trials: number): Promise<ArmSetup> {
	bootstrapArmSchema(arm);
	const seeded = await seedArmProfiles(arm, trials);
	const envUrl = process.env.EVAL_API_URL;
	if (envUrl) return { seeded, apiUrl: envUrl, stop: () => {} };
	const server = await startDevServer(arm, DEV_SERVER_PORT);
	return { seeded, apiUrl: server.url, stop: server.stop };
}

function printVerdicts(
	rows: readonly { input: TrialCase; output: TrialOutput }[],
): void {
	for (const { input, output } of rows) {
		if (output.skipped) {
			console.log(
				`${input.slug} t${input.trialIndex}: skipped (${output.skipped})`,
			);
			continue;
		}
		const verdict = output.verdict;
		if (!verdict) continue;
		console.log(
			`${input.slug} t${input.trialIndex}: ${verdict.allGatesPass ? "PASS" : "FAIL"} gates, ` +
				`coverage ${verdict.qualifiedCoverage ?? "n/a"}, ` +
				`$${(verdict.costPerStoredCompany ?? 0).toFixed(3)}/company, ` +
				`${(verdict.secondsPerStoredCompany ?? 0).toFixed(1)}s/company`,
		);
	}
}

export function runIdsByProfile(
	rows: readonly { input: TrialCase; output: TrialOutput }[],
): Record<string, string[]> {
	const byProfile: Record<string, string[]> = {};
	for (const { input, output } of rows) {
		if (!output.runId) continue;
		byProfile[input.slug] = [...(byProfile[input.slug] ?? []), output.runId];
	}
	return byProfile;
}

type ManifestContext = {
	experiment: string;
	commit: string;
	arm: string;
	startedAt: string;
	budget: Budget;
	rows: readonly { input: TrialCase; output: TrialOutput }[];
	datasetSnapshotIds: Record<string, string | null>;
};

async function writeExperimentManifest(
	context: ManifestContext,
): Promise<void> {
	const manifest = await buildManifest({
		experiment: context.experiment,
		commit: context.commit,
		arm: context.arm,
		datasetSnapshotIds: context.datasetSnapshotIds,
		configText: readFileSync("config.yaml", "utf8"),
		scorerPrompts: {},
		resolvedModelIds: {},
		runIds: runIdsByProfile(context.rows),
		startedAt: context.startedAt,
		finishedAt: new Date().toISOString(),
		totalSpendDollars: context.budget.spent,
		perProfileSpendDollars: context.budget.perProfile,
	});
	mkdirSync("eval/runs", { recursive: true });
	writeFileSync(
		`eval/runs/${context.experiment}.json`,
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const profiles = selectedProfiles(args.profile);
	const datasetSnapshotIds = await syncDatasetsFor(profiles);
	const { seeded, apiUrl, stop } = await setUpArm(args.arm, args.trials);
	const cases = casesFor(seeded).filter((trial) =>
		profiles.some((profile) => profile.slug === trial.slug),
	);
	const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
	const budget = newBudget(profiles.map((profile) => profile.slug));
	const startedAt = new Date().toISOString();
	const commit = gitCommit();
	const experiment = `${commit.slice(0, 12)}-${args.arm}`;
	try {
		const result = await Eval("algo-backend", {
			data: cases.map((trial) => ({ input: trial })),
			task: buildTask(apiUrl, sql, budget, { arm: args.arm, commit }),
			scores: CODE_SCORERS,
			experimentName: experiment,
			metadata: { commit, arm: args.arm },
			maxConcurrency: 1,
		});
		const rows = result.results.map((row) => ({
			input: row.input,
			output: row.output,
		}));
		await writeExperimentManifest({
			experiment,
			commit,
			arm: args.arm,
			startedAt,
			budget,
			rows,
			datasetSnapshotIds,
		});
		printVerdicts(rows);
		console.log(`eval: total spend $${budget.spent.toFixed(4)}`);
		console.log(
			`eval: experiment ${result.summary.experimentUrl ?? experiment}`,
		);
	} finally {
		await sql.end();
		stop();
	}
}

if (import.meta.main) {
	await main();
}
