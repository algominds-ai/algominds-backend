import { execFileSync } from "node:child_process";
import { armDatabaseUrl } from "@eval/arm-db";
import type { CompaniesStageResult, PeopleStageResult } from "@eval/full-chain";
import { scoreTrial } from "@eval/full-chain";
import { computeVerdict } from "@eval/headline";
import { readKeyFile, readPeopleKeyFile } from "@eval/keys-io";
import { computePeopleVerdict } from "@eval/people-headline";
import { fetchRunCompanies, fetchRunPeople } from "@eval/people-run";
import type { Profile } from "@eval/profiles";
import { BRAINTRUST_PROJECT, profilesFor } from "@eval/profiles";
import {
	readRequiresProvingPass,
	readRunReport,
	readRunStatus,
	readStoredCompanies,
} from "@eval/read";
import type { TrialOutput } from "@eval/scorers";
import { CODE_SCORERS } from "@eval/scorers";
import { Eval } from "braintrust";
import type { Sql } from "postgres";
import postgres from "postgres";

type RescoreInput = { slug: string; trialIndex: number; count: number };

function flagValue(argv: readonly string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index === -1 ? null : (argv[index + 1] ?? null);
}

async function latestRun(
	sql: Sql,
	slug: string,
	capability: string,
): Promise<string | null> {
	const rows = await sql<{ id: string }[]>`
		select r.id from run r
		join icp i on i.id = r.icp_id
		join organization o on o.id = i.organization_id
		where o.name like ${`eval-${slug}-t%`} and r.capability = ${capability}
		order by r.started_at desc limit 1`;
	return rows[0]?.id ?? null;
}

async function companiesStage(
	sql: Sql,
	profile: Profile,
	runId: string,
): Promise<CompaniesStageResult> {
	const run = await readRunReport(sql, runId);
	const stored = await readStoredCompanies(sql, runId);
	const key = readKeyFile(profile.slug, profile.icpId);
	const verdict = computeVerdict({
		key,
		run,
		bars: profile.bars,
		requiresProvingPass: await readRequiresProvingPass(sql, profile.icpId),
		stored,
	});
	return {
		companiesRunId: runId,
		companiesStatus: await readRunStatus(sql, runId),
		companiesCostDollars: run.costDollars,
		companiesStartedAt: run.startedAt,
		companiesFinishedAt: run.finishedAt,
		storedCompanies: stored,
		key,
		companyGates: {
			noKeyRejectedStored: verdict.gates.noKeyRejectedStored,
			noDuplicateOrganisationGroup: verdict.gates.noDuplicateOrganisationGroup,
			provingPassesWhereRequired: verdict.gates.provingPassesWhereRequired,
		},
	};
}

async function peopleStage(
	sql: Sql,
	profile: Profile,
	runId: string | null,
): Promise<PeopleStageResult> {
	const peopleKey = readPeopleKeyFile(profile.slug, profile.icpId);
	if (runId === null) {
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
	const run = await readRunReport(sql, runId);
	const status = await readRunStatus(sql, runId);
	const deliveredPeople = await fetchRunPeople(sql, runId);
	const peopleVerdict = computePeopleVerdict({
		key: peopleKey,
		run: { runId, status, costDollars: run.costDollars },
		companies: await fetchRunCompanies(sql, runId),
		people: deliveredPeople,
		bars: {
			maxCostDollars: profile.bars.maxCostDollars,
			countries: profile.countries,
		},
	});
	return {
		peopleRunId: runId,
		peopleStatus: status,
		peopleCostDollars: run.costDollars,
		peopleFinishedAt: run.finishedAt,
		deliveredPeople,
		peopleKey,
		peopleVerdict,
	};
}

function trialLine(slug: string, output: TrialOutput): string {
	const e = output.engine;
	if (!e) return `${slug}: no engine score`;
	return (
		`${slug}: score ${e.engineScore.toFixed(2)} yield ${e.acceptedCompanies} ` +
		`coverage ${e.acceptedCompaniesWithBuyer} buyer-precision ${e.acceptedPeople}/${e.deliveredPeopleCount} ` +
		`gates ${e.gatesPass ? "ok" : "FAIL"} $${output.totalCostDollars.toFixed(2)} ${output.totalSeconds ?? "?"}s`
	);
}

/** Rescores every profile's latest companies and people runs in `eval_<arm>` against the current keys, without vendor calls, and logs the result to Braintrust as `<commit>-<arm>-rescored`. */
async function main(argv: readonly string[]): Promise<void> {
	const arm = flagValue(argv, "--arm");
	if (!arm) throw new Error("eval:rescore needs --arm");
	const count = Number.parseInt(flagValue(argv, "--count") ?? "5", 10);
	const profiles = profilesFor(flagValue(argv, "--profile"));
	const sql = postgres(armDatabaseUrl(arm), { max: 1 });
	const outputs = new Map<string, TrialOutput>();
	try {
		for (const profile of profiles) {
			const companiesRunId = await latestRun(sql, profile.slug, "companies");
			if (companiesRunId === null) continue;
			const companies = await companiesStage(sql, profile, companiesRunId);
			const peopleRunId = await latestRun(sql, profile.slug, "people");
			const people = await peopleStage(sql, profile, peopleRunId);
			outputs.set(profile.slug, scoreTrial(profile, count, companies, people));
		}
	} finally {
		await sql.end();
	}
	const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const result = await Eval<RescoreInput, TrialOutput, void>(
		BRAINTRUST_PROJECT,
		{
			data: [...outputs.keys()].map((slug) => ({
				input: { slug, trialIndex: 0, count },
			})),
			task: async (input) => {
				const output = outputs.get(input.slug);
				if (!output)
					throw new Error(`eval:rescore no output for ${input.slug}`);
				return output;
			},
			scores: CODE_SCORERS,
			experimentName: `${commit}-${arm}-rescored`,
			metadata: { commit, arm, rescored: true },
			maxConcurrency: 1,
		},
	);
	let total = 0;
	for (const [slug, output] of outputs) {
		console.log(trialLine(slug, output));
		total += output.engine?.engineScore ?? 0;
	}
	console.log(
		`rating ${((10 * total) / Math.max(1, outputs.size)).toFixed(2)}`,
	);
	console.log(`eval: experiment ${result.summary.experimentUrl ?? "(no url)"}`);
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
