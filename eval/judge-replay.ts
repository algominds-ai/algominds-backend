import { spawn } from "node:child_process";
import {
	type ExpectedVerdict,
	loadCapturedCases,
	loadCase,
	loadRunCases,
	parseRowsFlag,
	REPLAY_TARGETS,
	type ReplayCase,
} from "@eval/judge-replay-cases";
import { it } from "vitest";
import { z } from "zod";
import { config } from "@/config";
import { judge } from "@/core/companies/judge";
import {
	type EvidenceByRow,
	judgedFields,
	type Verdict,
} from "@/core/companies/judge-evidence";
import {
	conditionRefs,
	type Requirement,
	requiredConditionRefs,
	requiredSatisfied,
	requirementLine,
} from "@/core/requirements";

const SLICE_TIMEOUT_MS = 90_000;
const DEFAULT_COST_CAP_DOLLARS = 0.5;

function keptRow(
	requirements: readonly Requirement[],
	verdict: Verdict | undefined,
): boolean {
	return (
		verdict !== undefined &&
		requiredSatisfied(
			requirements,
			new Map(verdict.statuses.map((entry) => [entry.id, entry.status])),
		)
	);
}

/**
 * Every case sliced to at most `batchSize` rows per judge call, one
 * profile's rows never spanning a slice with another's, since one call
 * judges every row in it against a single `requirements` list. `judge()`
 * itself re-slices past `config.companies.judgeBatchSize` (its own module
 * constant, not exposed as a parameter), so a `batchSize` above that runs as
 * more than one concurrent call rather than the single call its name implies.
 */
function sliceCases(
	cases: readonly ReplayCase[],
	batchSize: number,
): ReplayCase[][] {
	const groups = new Map<string, ReplayCase[]>();
	for (const replayCase of cases) {
		const key = `${replayCase.database}::${replayCase.icpId ?? "none"}`;
		const group = groups.get(key) ?? [];
		group.push(replayCase);
		groups.set(key, group);
	}
	const slices: ReplayCase[][] = [];
	for (const group of groups.values()) {
		for (let offset = 0; offset < group.length; offset += batchSize) {
			slices.push(group.slice(offset, offset + batchSize));
		}
	}
	return slices;
}

function printDryRun(cases: readonly ReplayCase[], batchSize: number): void {
	const slices = sliceCases(cases, batchSize);
	console.log(
		`${cases.length} row(s) across ${slices.length} slice(s) of up to ${batchSize}`,
	);
	for (const replayCase of cases) {
		console.log(
			`\n${replayCase.domain}  expected=${replayCase.expected}  database=${replayCase.database}`,
		);
		console.log(
			`  hard requirements: ${conditionRefs(replayCase.requirements)
				.filter((ref) => ref.kind === "required")
				.map(requirementLine)
				.join(" | ")}`,
		);
		const evidenceMap = new Map(Object.entries(replayCase.pageEvidence));
		console.log(
			`  fields: ${JSON.stringify(judgedFields(replayCase.row, evidenceMap))}`,
		);
	}
}

const LiveInputSchema = z.object({
	JUDGE_REPLAY_CASES: z.string().min(1),
	JUDGE_REPLAY_BATCH: z.string().min(1),
	JUDGE_REPLAY_CAP: z.string().min(1),
	JUDGE_REPLAY_TWO_PASS: z.string().min(1),
	JUDGE_REPLAY_AIG_TOKEN: z.string().min(1),
	JUDGE_REPLAY_GATEWAY_BASE_URL: z.string().min(1),
	JUDGE_REPLAY_MODEL_ROUTE: z.string().min(1),
});

type LiveInput = {
	env: Env;
	cases: ReplayCase[];
	batchSize: number;
	capDollars: number;
	twoPass: boolean;
};

/** `testEnv` with the vendor secret and gateway routing replaced by the real values a wrapping `vitest.judge-replay.config.ts` reads from `process.env`. */
async function liveEnv(): Promise<LiveInput> {
	const { env: testEnv } = await import("cloudflare:workers");
	const input = LiveInputSchema.parse(testEnv);
	return {
		cases: JSON.parse(input.JUDGE_REPLAY_CASES),
		batchSize: Number.parseInt(input.JUDGE_REPLAY_BATCH, 10),
		capDollars: Number.parseFloat(input.JUDGE_REPLAY_CAP),
		twoPass: input.JUDGE_REPLAY_TWO_PASS === "1",
		env: {
			...testEnv,
			CF_AIG_TOKEN: { get: async () => input.JUDGE_REPLAY_AIG_TOKEN },
			AI_GATEWAY_BASE_URL: input.JUDGE_REPLAY_GATEWAY_BASE_URL,
			MODEL_ROUTE_REASONING: input.JUDGE_REPLAY_MODEL_ROUTE,
		},
	};
}

function printMustBeProven(
	replayCase: ReplayCase,
	verdict: Verdict | undefined,
): void {
	for (const req of requiredConditionRefs(replayCase.requirements)) {
		const entry = verdict?.statuses.find((status) => status.id === req.id);
		console.log(`    ${req.id}: ${entry?.status ?? "unproven"}`);
	}
}

function printAllHardStatuses(
	replayCase: ReplayCase,
	verdict: Verdict | undefined,
): void {
	for (const req of conditionRefs(replayCase.requirements).filter(
		(ref) => ref.kind === "required",
	)) {
		const entry = verdict?.statuses.find((status) => status.id === req.id);
		console.log(`    all: ${req.id}: ${entry?.status ?? "unproven"}`);
	}
}

type RowOutcome = { pass: boolean; actual: ExpectedVerdict };

/** One row's line: kept or refused against `expected`, then every `requiredConditionRefs` requirement's status, quote and whether that quote grounds in the row's own evidence. A mismatch also prints every hard requirement's status, since a refusal can turn on one this profile never marked `requiredConditionRefs`. */
function printRowVerdict(
	replayCase: ReplayCase,
	verdict: Verdict | undefined,
): RowOutcome {
	const actual: ExpectedVerdict = keptRow(replayCase.requirements, verdict)
		? "retain"
		: "reject";
	const pass = actual === replayCase.expected;
	console.log(
		`  ${replayCase.domain}  expected=${replayCase.expected}  actual=${actual}  ${pass ? "PASS" : "FAIL"}`,
	);
	printMustBeProven(replayCase, verdict);
	if (!pass) printAllHardStatuses(replayCase, verdict);
	if (verdict?.reason) console.log(`    reason: ${verdict.reason}`);
	return { pass, actual };
}

type SliceOutcome = {
	accuratePasses: number;
	timeoutOk: boolean;
	dollars: number;
	decisions: Map<string, ExpectedVerdict>;
};

/** One judge call over one slice: every row's verdict, then the slice's own wall time, model call count, gateway cost and the "under 90 s, no retry" line the timeout screen exists for. */
function printFieldSizes(replayCase: ReplayCase): void {
	const descLen = replayCase.row.description?.length ?? 0;
	console.log(`  ${replayCase.domain}  description: ${descLen} chars`);
	for (const [key, evidence] of Object.entries(replayCase.pageEvidence)) {
		console.log(`    ${key}: ${evidence.quote.length} chars`);
	}
}

/** The slice's outcome when `judge()` itself throws, most often a double timeout: every row in it fails with the elapsed time and the error's own message, so the pass can move on to the next slice instead of crashing. */
function failedSliceOutcome(
	caseSlice: readonly ReplayCase[],
	ms: number,
	error: unknown,
): SliceOutcome {
	const message = error instanceof Error ? error.message : String(error);
	for (const replayCase of caseSlice) {
		console.log(`  ${replayCase.domain}  FAIL (${ms}ms, threw: ${message})`);
	}
	console.log(
		`  ${ms}ms, 0 model call(s)  FAIL (every slice under 90 s, no retry)`,
	);
	return {
		accuratePasses: 0,
		timeoutOk: false,
		dollars: 0,
		decisions: new Map(),
	};
}

/** One judge call over one slice: every row's field sizes and verdict, then the slice's own wall time, model call count, gateway cost and the "under 90 s, no retry" line the timeout screen exists for. A thrown error becomes a failed outcome instead of crashing the pass. */
async function judgeSlice(
	caseSlice: readonly ReplayCase[],
	env: Env,
	sliceLabel: string,
): Promise<SliceOutcome> {
	const requirements = caseSlice[0]?.requirements ?? [];
	const rows = caseSlice.map((replayCase) => replayCase.row);
	const evidenceByRow: EvidenceByRow = new Map(
		caseSlice.map((replayCase, index) => [
			index,
			new Map(Object.entries(replayCase.pageEvidence)),
		]),
	);
	console.log(`\n${sliceLabel}: ${caseSlice.length} row(s)`);
	for (const replayCase of caseSlice) printFieldSizes(replayCase);
	const started = Date.now();
	let result: Awaited<ReturnType<typeof judge>>;
	try {
		result = await judge(requirements, rows, env, { evidenceByRow });
	} catch (error) {
		return failedSliceOutcome(caseSlice, Date.now() - started, error);
	}
	const ms = Date.now() - started;
	const { verdicts, ledger } = result;
	const summary = ledger.toJSON();
	const modelCalls = summary.entries.filter(
		(entry) => entry.op === "judge",
	).length;
	let accuratePasses = 0;
	const decisions = new Map<string, ExpectedVerdict>();
	caseSlice.forEach((replayCase, index) => {
		const outcome = printRowVerdict(replayCase, verdicts[index]);
		decisions.set(replayCase.domain, outcome.actual);
		if (outcome.pass) accuratePasses++;
	});
	const timeoutOk = ms < SLICE_TIMEOUT_MS && modelCalls <= 1;
	console.log(
		`  ${ms}ms, ${modelCalls} model call(s), $${summary.total.toFixed(4)}  ${timeoutOk ? "PASS" : "FAIL"} (every slice under 90 s, no retry)`,
	);
	return { accuratePasses, timeoutOk, dollars: summary.total, decisions };
}

type PassOutcome = {
	decisions: Map<string, ExpectedVerdict>;
	accuratePasses: number;
	timeoutPasses: number;
	sliceCount: number;
	dollars: number;
};

type PassConfig = { label: string; reverse: boolean; capRemaining: number };

/** One full pass over every slice, in `reverse` row order or not, stopping once `capRemaining` is spent. Row order changes the request body the model sees, so a reversed second pass cannot repeat the first pass's gateway cache hit. */
async function runPass(
	slices: readonly ReplayCase[][],
	env: Env,
	config: PassConfig,
): Promise<PassOutcome> {
	const decisions = new Map<string, ExpectedVerdict>();
	let accuratePasses = 0;
	let timeoutPasses = 0;
	let dollars = 0;
	for (const [index, slice] of slices.entries()) {
		if (dollars >= config.capRemaining) {
			console.log(
				`\n${config.label}: stopping before slice ${index + 1} of ${slices.length}: $${dollars.toFixed(4)} already at the $${config.capRemaining.toFixed(4)} remaining cap`,
			);
			break;
		}
		const ordered = config.reverse ? [...slice].reverse() : slice;
		const outcome = await judgeSlice(
			ordered,
			env,
			`${config.label} slice ${index + 1} of ${slices.length}`,
		);
		accuratePasses += outcome.accuratePasses;
		timeoutPasses += outcome.timeoutOk ? 1 : 0;
		dollars += outcome.dollars;
		for (const [domain, actual] of outcome.decisions) {
			decisions.set(domain, actual);
		}
	}
	return {
		decisions,
		accuratePasses,
		timeoutPasses,
		sliceCount: slices.length,
		dollars,
	};
}

function printPassSummary(outcome: PassOutcome, totalRows: number): void {
	console.log(
		`\n${outcome.accuratePasses} of ${totalRows} rows matched expected`,
	);
	console.log(
		`${outcome.timeoutPasses} of ${outcome.sliceCount} slices under 90 s with no retry`,
	);
	console.log(`$${outcome.dollars.toFixed(4)} for this pass`);
}

function passesAgree(pass1: PassOutcome, pass2: PassOutcome): boolean {
	if (pass1.decisions.size !== pass2.decisions.size) return false;
	for (const [domain, actual] of pass1.decisions) {
		if (pass2.decisions.get(domain) !== actual) return false;
	}
	return true;
}

async function runLive(): Promise<void> {
	const { env, cases, batchSize, capDollars, twoPass } = await liveEnv();
	const slices = sliceCases(cases, batchSize);
	const started = Date.now();
	console.log("\n=== pass 1 (forward order) ===");
	const pass1 = await runPass(slices, env, {
		label: "pass 1",
		reverse: false,
		capRemaining: capDollars,
	});
	printPassSummary(pass1, cases.length);
	if (!twoPass) {
		console.log(
			`$${pass1.dollars.toFixed(4)} total, ${Date.now() - started}ms wall time`,
		);
		return;
	}
	console.log("\n=== pass 2 (reversed order, must miss cache) ===");
	const pass2 = await runPass(slices, env, {
		label: "pass 2",
		reverse: true,
		capRemaining: Math.max(0, capDollars - pass1.dollars),
	});
	printPassSummary(pass2, cases.length);
	console.log(`\nboth passes agree on every row: ${passesAgree(pass1, pass2)}`);
	console.log(
		`$${(pass1.dollars + pass2.dollars).toFixed(4)} total across both passes, ${Date.now() - started}ms wall time`,
	);
}

function flagValue(argv: readonly string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index === -1 ? null : (argv[index + 1] ?? null);
}

function loadCases(argv: readonly string[]): Promise<ReplayCase[]> {
	const capturedFlag = flagValue(argv, "--captured");
	if (capturedFlag) return loadCapturedCases(capturedFlag);
	const rowsFlag = flagValue(argv, "--rows");
	if (rowsFlag) return loadRunCases(parseRowsFlag(rowsFlag));
	return Promise.all(REPLAY_TARGETS.map(loadCase));
}

function warnAboveInternalBatch(batchSize: number): void {
	const internal = config.companies.judgeBatchSize;
	if (batchSize <= internal) return;
	console.log(
		`note: judge() re-slices internally above ${internal} rows, so --batch ${batchSize} runs as ${Math.ceil(batchSize / internal)} concurrent call(s) of up to ${internal}, not one call of ${batchSize}`,
	);
}

async function main(argv: readonly string[]): Promise<void> {
	const batchSize =
		Number.parseInt(flagValue(argv, "--batch") ?? "", 10) ||
		config.companies.judgeBatchSize;
	const capDollars =
		Number.parseFloat(flagValue(argv, "--cap") ?? "") ||
		DEFAULT_COST_CAP_DOLLARS;
	const twoPass = argv.includes("--captured") && argv.includes("--two-pass");
	warnAboveInternalBatch(batchSize);
	const cases = await loadCases(argv);
	if (argv.includes("--dry-run")) {
		printDryRun(cases, batchSize);
		return;
	}
	const child = spawn(
		"bunx",
		["vitest", "run", "--config", "vitest.judge-replay.config.ts"],
		{
			stdio: "inherit",
			env: {
				...process.env,
				JUDGE_REPLAY_CASES: JSON.stringify(cases),
				JUDGE_REPLAY_BATCH: String(batchSize),
				JUDGE_REPLAY_CAP: String(capDollars),
				JUDGE_REPLAY_TWO_PASS: twoPass ? "1" : "0",
			},
		},
	);
	await new Promise<void>((resolve, reject) => {
		child.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`eval:judge:replay exited ${code}`)),
		);
	});
}

if (import.meta.main) {
	await main(process.argv.slice(2));
} else {
	it("replays the judge over saved rows", { timeout: 600_000 }, runLive);
}
