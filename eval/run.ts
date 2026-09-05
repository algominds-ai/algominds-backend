import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { SeededTrial } from "@eval/arm-db";
import {
	armDatabaseUrl,
	bootstrapArmSchema,
	seedArmProfiles,
} from "@eval/arm-db";
import { openKeyDataset, syncKeyDataset } from "@eval/datasets";
import { startDevServer } from "@eval/dev-server";
import type {
	Budget,
	SanitizedInput,
	TrialCase,
	TrialMetadata,
} from "@eval/full-chain";
import {
	buildTask,
	casesFor,
	emptyTrialMetadata,
	newBudget,
	sanitizedInputFor,
} from "@eval/full-chain";
import { readKeyFile } from "@eval/keys-io";
import { seedKeyFileFromArm } from "@eval/label";
import { buildManifest } from "@eval/manifest";
import {
	COMPANIES_PER_RUN,
	MIN_TRIALS,
	type PROFILES,
	profilesFor,
} from "@eval/profiles";
import type { TrialOutput } from "@eval/scorers";
import { CODE_SCORERS } from "@eval/scorers";
import { Eval } from "braintrust";
import postgres from "postgres";

const DEV_SERVER_PORT = 8787;

export type RunArgs = {
	profile: string | null;
	arm: string;
	trials: number;
	count: number;
	port: number;
};

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
	const count = Number.parseInt(
		flagValue(argv, "--count") ?? String(COMPANIES_PER_RUN),
		10,
	);
	const port = Number.parseInt(
		flagValue(argv, "--port") ?? String(DEV_SERVER_PORT),
		10,
	);
	if (!Number.isInteger(count) || count < 1) {
		throw new Error("eval: --count must be a positive integer");
	}
	if (!Number.isInteger(port) || port < 1024) {
		throw new Error("eval: --port must be an integer above 1023");
	}
	return { profile, arm, trials, count, port };
}

export function selectedProfiles(
	slug: string | null,
): readonly (typeof PROFILES)[number][] {
	return profilesFor(slug);
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

type ArmSetup = { seeded: SeededTrial[]; apiUrl: string; stop: () => void };

async function setUpArm(
	arm: string,
	trials: number,
	port: number,
): Promise<ArmSetup> {
	bootstrapArmSchema(arm);
	const seeded = await seedArmProfiles(arm, trials);
	const envUrl = process.env.EVAL_API_URL;
	if (envUrl) return { seeded, apiUrl: envUrl, stop: () => {} };
	const server = await startDevServer(arm, port);
	return { seeded, apiUrl: server.url, stop: server.stop };
}

export type ResultRow = { input: SanitizedInput; output: TrialOutput };

function trialLine(row: ResultRow): string {
	const label = `${row.input.slug} t${row.input.trialIndex}`;
	if (row.output.skipped) return `${label}: skipped (${row.output.skipped})`;
	const engine = row.output.engine;
	if (!engine) return `${label}: no output (the trial threw)`;
	const requested = row.input.count;
	const seconds = row.output.totalSeconds ?? 0;
	return (
		`${label}: score ${engine.engineScore.toFixed(2)} ` +
		`yield ${engine.acceptedCompanies}/${requested} ` +
		`coverage ${engine.acceptedCompaniesWithBuyer}/${requested} ` +
		`buyer-precision ${engine.acceptedPeople}/${engine.deliveredPeopleCount} ` +
		`$${row.output.totalCostDollars.toFixed(2)} ${seconds.toFixed(1)}s`
	);
}

function printTrialLines(rows: readonly ResultRow[]): void {
	for (const row of rows) console.log(trialLine(row));
}

function meanEngineScore(rows: readonly ResultRow[]): number {
	const scores = rows
		.map((row) => row.output.engine?.engineScore)
		.filter((score): score is number => score !== undefined);
	if (scores.length === 0) return 0;
	return scores.reduce((total, score) => total + score, 0) / scores.length;
}

async function seedKeyFiles(
	sql: postgres.Sql,
	profiles: typeof PROFILES,
): Promise<void> {
	for (const profile of profiles) {
		const seeded = await seedKeyFileFromArm(sql, profile.slug);
		console.log(
			`${profile.slug}: ${seeded.companyCount} companies, ${seeded.unlabelledCount} unlabelled`,
		);
	}
}

export function runIdsByProfile(
	rows: readonly ResultRow[],
): Record<string, string[]> {
	const byProfile: Record<string, string[]> = {};
	for (const { input, output } of rows) {
		const ids = [output.companiesRunId, output.peopleRunId].filter(
			(id): id is string => id !== null,
		);
		if (ids.length === 0) continue;
		byProfile[input.slug] = [...(byProfile[input.slug] ?? []), ...ids];
	}
	return byProfile;
}

type ManifestContext = {
	experiment: string;
	commit: string;
	arm: string;
	startedAt: string;
	budget: Budget;
	rows: readonly ResultRow[];
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

type EvalContext = {
	apiUrl: string;
	sql: postgres.Sql;
	budget: Budget;
	cases: readonly TrialCase[];
	count: number;
	experiment: string;
	commit: string;
	arm: string;
};

async function runEval(context: EvalContext): Promise<{
	results: readonly ResultRow[];
	experimentUrl: string | undefined;
}> {
	const { apiUrl, sql, budget, cases, count, experiment, commit, arm } =
		context;
	const result = await Eval<SanitizedInput, TrialOutput, void, TrialMetadata>(
		"algo-backend",
		{
			data: cases.map((trial) => ({
				input: sanitizedInputFor(trial, count),
				metadata: emptyTrialMetadata(),
			})),
			task: buildTask(apiUrl, sql, budget, cases),
			scores: CODE_SCORERS,
			experimentName: experiment,
			metadata: { commit, arm },
			maxConcurrency: 1,
		},
	);
	return {
		results: result.results.map((row) => ({
			input: row.input,
			output: row.output,
		})),
		experimentUrl: result.summary.experimentUrl,
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const profiles = selectedProfiles(args.profile);
	const datasetSnapshotIds = await syncDatasetsFor(profiles);
	const { seeded, apiUrl, stop } = await setUpArm(
		args.arm,
		args.trials,
		args.port,
	);
	const scale = args.count / COMPANIES_PER_RUN;
	const cases = casesFor(seeded, scale).filter((trial) =>
		profiles.some((profile) => profile.slug === trial.slug),
	);
	const sql = postgres(armDatabaseUrl(args.arm), { max: 1 });
	const budget = newBudget(
		profiles.map((profile) => profile.slug),
		scale,
	);
	const startedAt = new Date().toISOString();
	const commit = gitCommit();
	const experiment = `${commit.slice(0, 12)}-${args.arm}`;
	try {
		const { results, experimentUrl } = await runEval({
			apiUrl,
			sql,
			budget,
			cases,
			count: args.count,
			experiment,
			commit,
			arm: args.arm,
		});
		await writeExperimentManifest({
			experiment,
			commit,
			arm: args.arm,
			startedAt,
			budget,
			rows: results,
			datasetSnapshotIds,
		});
		await seedKeyFiles(sql, profiles);
		printTrialLines(results);
		console.log(`rating ${(10 * meanEngineScore(results)).toFixed(2)}`);
		console.log(`eval: total spend $${budget.spent.toFixed(4)}`);
		console.log(`eval: experiment ${experimentUrl ?? experiment}`);
	} finally {
		await sql.end();
		stop();
	}
}

if (import.meta.main) {
	await main();
}
