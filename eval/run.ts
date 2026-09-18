import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { options } from "@eval/args";
import { bootstrapArmSchema } from "@eval/arm-db";
import { startDevServer } from "@eval/dev-server";
import { qualityScorer, verifySources } from "@eval/judge";
import {
	CaseSchema,
	type Expected,
	failedOutput,
	type Input,
	type Output,
} from "@eval/schema";
import { referenceScores, structuralScores } from "@eval/scores";
import { runCase } from "@eval/task";
import { currentSpan, Eval, initDataset, loadPrompt } from "braintrust";
import { z } from "zod";

type Options = ReturnType<typeof options>;

const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set([
	"complete",
	"capped",
	"empty",
	"short",
	"exhausted",
]);

function shouldHalt(output: Output): boolean {
	return (
		output.error !== null ||
		output.costDollars === null ||
		!TERMINAL_OUTCOMES.has(output.status)
	);
}

async function loadCases(args: Options) {
	if (args.local) {
		const text = readFileSync(`eval/${args.suite}/cases.json`, "utf8");
		return {
			rows: selectCases(z.array(CaseSchema).parse(JSON.parse(text)), args),
			version: createHash("sha256").update(text).digest("hex"),
			id: null,
		};
	}
	const dataset = initDataset({
		project: "algo-backend",
		dataset: `${args.suite}-discovery`,
		...(args.version ? { version: args.version } : {}),
	});
	const version = await dataset.version();
	if (!version)
		throw new Error("eval: dataset has no version; run eval:datasets first");
	const rows = selectCases(
		(
			await initDataset({
				project: "algo-backend",
				dataset: `${args.suite}-discovery`,
				version,
			}).fetchedData()
		).map((row) => CaseSchema.parse(row)),
		args,
	);
	return { rows, version, id: await dataset.id };
}

function selectCases(rows: z.infer<typeof CaseSchema>[], args: Options) {
	const selected = rows.filter(
		(row) =>
			(!args.profile || row.input.slug === args.profile) &&
			(!args.caseId || row.id === args.caseId) &&
			row.input.stage === args.stage,
	);
	if (!selected.length) throw new Error("eval: no matching cases");
	if (selected.some((row) => row.input.suite !== args.suite))
		throw new Error("eval: mixed suite dataset");
	return selected;
}

function sourceMetadata() {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const files = execFileSync(
		"git",
		[
			"ls-files",
			"-co",
			"--exclude-standard",
			"src",
			"eval",
			"config.yaml",
			"package.json",
			"bun.lock",
		],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n");
	const hash = createHash("sha256");
	for (const path of [...new Set(files)].sort())
		if (existsSync(path)) hash.update(path).update(readFileSync(path));
	return { commit, sourceHash: hash.digest("hex") };
}

async function verify(output: Output, codeOnly: boolean) {
	if (codeOnly || output.status !== "complete") return output;
	try {
		return await verifySources(output);
	} catch (error) {
		return {
			...output,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function taskFor(
	args: Options,
	context: { arm: string; url: string; timeout: number; token: string },
) {
	let spent = 0;
	let halted = false;
	return async (input: Input) => {
		if (halted || spent >= args.maxSpend)
			return failedOutput(
				"Stopped: prior failure, unresolved spend, or spend ceiling reached",
			);
		const output = await verify(
			await runCase(input, context),
			args.codeOnly || input.stage !== "engine",
		);
		spent += (output.costDollars ?? 0) + (output.verificationCostDollars ?? 0);
		halted = shouldHalt(output);
		currentSpan().log({
			metrics: {
				...(output.costDollars !== null
					? { engine_cost: output.costDollars }
					: {}),
				...(output.verificationCostDollars !== null
					? { source_read_cost: output.verificationCostDollars }
					: {}),
			},
			metadata: {
				costKnown: output.costDollars !== null,
				seconds: output.seconds,
			},
		});
		return output;
	};
}

async function main() {
	const args = options(process.argv.slice(2));
	const dataset = await loadCases(args);
	const judge = args.codeOnly
		? null
		: await loadPrompt({
				projectName: "algo-backend",
				slug: `${args.suite}-quality`,
			});
	const judgeVersion = judge?.version;
	if (!args.codeOnly && !judgeVersion)
		throw new Error("eval: missing versioned quality scorer");
	const arm = `${args.suite}_${Date.now()}`;
	if (args.stage === "engine") bootstrapArmSchema(arm);
	const server = await startDevServer(arm, args.port);
	try {
		const result = await Eval<Input, Output, Expected>(
			"algo-backend",
			{
				data: dataset.rows,
				experimentName: arm,
				summarizeScores: Boolean(args.baseline),
				trialCount: args.trials,
				maxConcurrency: 1,
				...(args.baseline ? { baseExperimentName: args.baseline } : {}),
				metadata: {
					suite: args.suite,
					stage: args.stage,
					datasetId: dataset.id,
					datasetVersion: dataset.version,
					judgeVersion,
					...sourceMetadata(),
					codeOnly: args.codeOnly,
					maxSpend: args.maxSpend,
				},
				task: taskFor(args, {
					arm,
					url: server.url,
					timeout: args.timeout,
					token: server.token,
				}),
				scores: [
					({ input, output }) => structuralScores(input, output),
					({ input, output, expected }) =>
						input.stage !== "engine" || args.suite === "onboarding" || !expected
							? []
							: referenceScores(output, expected),
					...(judgeVersion ? [qualityScorer(args.suite, judgeVersion)] : []),
				],
			},
			{ noSendLogs: args.local },
		);
		if (args.local) console.log(JSON.stringify(result.results));
		if (!args.local) console.log(result.summary.experimentUrl);
		console.log(
			JSON.stringify({
				suite: args.suite,
				cases: result.results.length,
				codeOnly: args.codeOnly,
			}),
		);
		if (
			result.results.some(
				(row) => row.error || row.output.error || row.scores.run_complete !== 1,
			)
		)
			process.exitCode = 1;
	} finally {
		server.stop();
	}
}

if (import.meta.main) await main();
