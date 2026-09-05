import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ApiClient } from "@eval/api-client";
import { startCompaniesRun, waitForRunTerminal } from "@eval/api-client";
import type { SeededTrial } from "@eval/arm-db";
import {
	armDatabaseUrl,
	bootstrapArmSchema,
	seedArmProfiles,
} from "@eval/arm-db";
import { openKeyDataset, syncKeyDataset } from "@eval/datasets";
import { startDevServer } from "@eval/dev-server";
import { computeVerdict } from "@eval/headline";
import { readKeyFile } from "@eval/keys-io";
import { seedKeyFileFromArm } from "@eval/label";
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

type TrialResult = TrialOutput & { costDollars: number };

async function runOneTrial(
	client: ApiClient,
	sql: postgres.Sql,
	trial: TrialCase,
	count: number,
): Promise<TrialResult> {
	const runId = await startCompaniesRun(client, trial.icpId, count);
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
	return { verdict, runId, skipped: null, costDollars: run.costDollars };
}

/** One trial's task: skip it without spending anything once the budget blocks it, otherwise start, wait, read back and score it, banking what it actually cost. */
function buildTask(
	apiUrl: string,
	sql: postgres.Sql,
	budget: Budget,
	count: number,
) {
	return async (trial: TrialCase): Promise<TrialOutput> => {
		const blocked = budgetBlock(budget, trial.slug);
		if (blocked) return { verdict: null, runId: null, skipped: blocked };
		const client: ApiClient = { baseUrl: apiUrl, apiKey: trial.apiKey };
		const result = await runOneTrial(client, sql, trial, count);
		bankSpend(budget, trial.slug, result.costDollars);
		return { verdict: result.verdict, runId: result.runId, skipped: null };
	};
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

async function companyLabelPairs(
	sql: postgres.Sql,
	slug: string,
	runId: string,
): Promise<string> {
	const profile = profileBySlug(slug);
	if (!profile) return "";
	const key = readKeyFile(profile.slug, profile.icpId);
	const stored = await readStoredCompanies(sql, runId);
	return stored
		.map((row) => `${row.domain}:${key.companies[row.domain]?.label ?? "-"}`)
		.join(", ");
}

async function verdictLine(
	sql: postgres.Sql,
	input: TrialCase,
	output: TrialOutput,
): Promise<string | null> {
	const label = `${input.slug} t${input.trialIndex}`;
	if (!output) return `${label}: no output (the trial threw)`;
	if (output.skipped) return `${label}: skipped (${output.skipped})`;
	const verdict = output.verdict;
	if (!verdict || !output.runId) return null;
	const companies = await companyLabelPairs(sql, input.slug, output.runId);
	return (
		`${label}: ${verdict.allGatesPass ? "PASS" : "FAIL"} gates, ` +
		`precision ${verdict.precision ?? "n/a"}, ` +
		`$${(verdict.costPerStoredCompany ?? 0).toFixed(3)}/company, ` +
		`${(verdict.secondsPerStoredCompany ?? 0).toFixed(1)}s/company — ${companies}`
	);
}

async function printVerdicts(
	sql: postgres.Sql,
	rows: readonly { input: TrialCase; output: TrialOutput }[],
): Promise<void> {
	for (const { input, output } of rows) {
		const line = await verdictLine(sql, input, output);
		if (line) console.log(line);
	}
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
	rows: readonly { input: TrialCase; output: TrialOutput }[],
): Record<string, string[]> {
	const byProfile: Record<string, string[]> = {};
	for (const { input, output } of rows) {
		if (!output?.runId) continue;
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
		const result = await Eval("algo-backend", {
			data: cases.map((trial) => ({ input: trial })),
			task: buildTask(apiUrl, sql, budget, args.count),
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
		await seedKeyFiles(sql, profiles);
		await printVerdicts(sql, rows);
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
