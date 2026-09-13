import { readFileSync } from "node:fs";
import { Eval } from "braintrust";
import { z } from "zod";
import form3Input from "../exports/company-cycle-2026-09-06/form3-qualitative-judge-input.json";
import loopJudge from "../exports/company-cycle-2026-09-06/ondato-loop-bloxley-judged.json";
import groundingJudge from "../exports/company-cycle-2026-09-06/ondato-positive-negative-judged.json";
import ondatoInput from "../exports/company-cycle-2026-09-06/ondato-saved-judge-input.json";
import form3Judge from "../exports/company-cycle-2026-09-06/semantic-form3-judge.json";
import ondatoJudge from "../exports/company-cycle-2026-09-06/semantic-ondato-judge.json";

type Status = "proven" | "unproven" | "contradicted";
type Decision = "accept" | "reject";
type CapturedStatus = { id: string; status: Status };
type CapturedVerdict = { index: number; statuses: CapturedStatus[] };
type JudgeArtifact = {
	verdicts: CapturedVerdict[];
	decision: { stored: { domain: string }[] };
};
type CapturedOutput = { verdict: CapturedVerdict; decision: Decision };
type ReplayCase = {
	id: string;
	profile: string;
	domain: string;
	verdict: CapturedVerdict;
	actualDecision: Decision;
	expectedDecision: Decision;
	expectedStatuses: Record<string, Status>;
};

const labels: Record<
	string,
	{ decision: Decision; statuses: Record<string, Status> }
> = {
	"form3:spotify.com": {
		decision: "accept",
		statuses: {
			"r1.a1.c1": "proven",
			"r2.a1.c1": "proven",
			"r3.a1.c1": "proven",
			"r4.a1.c1": "proven",
			"r5.a1.c1": "proven",
			"r6.a1.c1": "proven",
		},
	},
	"form3:booking.com": {
		decision: "accept",
		statuses: {
			"r1.a1.c1": "proven",
			"r2.a1.c1": "proven",
			"r3.a1.c1": "proven",
			"r4.a1.c1": "proven",
			"r5.a1.c1": "proven",
			"r6.a1.c1": "proven",
		},
	},
	"form3:santanderdigitalservices.com": {
		decision: "reject",
		statuses: { "r1.a1.c1": "unproven" },
	},
	"ondato:wirexapp.com": {
		decision: "reject",
		statuses: { "r6.a3.c1": "unproven" },
	},
	"ondato:zbdpay.com": {
		decision: "reject",
		statuses: { "r1.a1.c1": "unproven", "r4.a1.c1": "proven" },
	},
	"ondato:yubo.live": {
		decision: "accept",
		statuses: { "r5.a1.c1": "proven", "r6.a4.c1": "proven" },
	},
	"ondato:bloxley.com": {
		decision: "reject",
		statuses: { "r5.a1.c1": "unproven" },
	},
	"ondato-loop:bloxley.com": {
		decision: "reject",
		statuses: { "r5.a1.c1": "unproven" },
	},
};

const artifactSchema = z.object({
	verdicts: z.array(
		z.object({
			index: z.number().int(),
			statuses: z.array(
				z.object({
					id: z.string(),
					status: z.enum(["proven", "unproven", "contradicted"]),
				}),
			),
		}),
	),
	decision: z.object({ stored: z.array(z.object({ domain: z.string() })) }),
});

function assertArtifact(value: unknown, source: string): JudgeArtifact {
	const parsed = artifactSchema.safeParse(value);
	if (!parsed.success)
		throw new Error(
			`invalid judge artifact ${source}: ${parsed.error.message}`,
		);
	return parsed.data;
}

function artifactFrom(
	path: string | undefined,
	fallback: unknown,
	name: string,
): JudgeArtifact {
	return path
		? assertArtifact(JSON.parse(readFileSync(path, "utf8")), path)
		: assertArtifact(fallback, name);
}

function casesFrom(
	profile: string,
	input: { rows: readonly { domain: string }[] },
	judged: JudgeArtifact,
): ReplayCase[] {
	return input.rows.map(({ domain }, index) => {
		const id = `${profile}:${domain}`;
		const verdict = judged.verdicts.find(
			(candidate) => candidate.index === index,
		);
		if (!verdict) throw new Error(`captured verdict missing for ${id}`);
		const label = labels[id];
		if (!label) throw new Error(`independent label missing for ${id}`);
		return {
			id,
			profile,
			domain,
			verdict,
			actualDecision: capturedDecision(judged, domain),
			expectedDecision: label.decision,
			expectedStatuses: label.statuses,
		};
	});
}

function capturedDecision(artifact: JudgeArtifact, domain: string): Decision {
	return artifact.decision.stored.some((row) => row.domain === domain)
		? "accept"
		: "reject";
}

function scoreCase(
	testCase: ReplayCase,
	output: CapturedOutput,
): { score: number; reason: string } {
	const statusMap = new Map(
		output.verdict.statuses.map((status) => [status.id, status.status]),
	);
	const mismatch = Object.entries(testCase.expectedStatuses).find(
		([id, expected]) => (statusMap.get(id) ?? "unproven") !== expected,
	);
	if (output.decision !== testCase.expectedDecision)
		return {
			score: 0,
			reason: `decision ${output.decision}, expected ${testCase.expectedDecision}`,
		};
	if (mismatch)
		return {
			score: 0,
			reason: `status ${mismatch[0]}=${statusMap.get(mismatch[0]) ?? "unproven (omitted)"}, expected ${mismatch[1]}`,
		};
	return { score: 1, reason: "decision and decisive statuses match" };
}

function cliPath(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index < 0) return undefined;
	const path = process.argv[index + 1];
	if (!path) throw new Error(`${flag} requires a path`);
	return path;
}

export async function runCompanyJudgeReplay(
	options: {
		form3Path?: string | undefined;
		ondatoPath?: string | undefined;
		groundingPath?: string | undefined;
	} = {},
): Promise<boolean> {
	const form3Artifact = artifactFrom(
		options.form3Path,
		form3Judge,
		"semantic-form3-judge.json",
	);
	const ondatoArtifact = artifactFrom(
		options.ondatoPath,
		ondatoJudge,
		"semantic-ondato-judge.json",
	);
	const cases = [
		...casesFrom("form3", form3Input, form3Artifact),
		...casesFrom("ondato", ondatoInput, ondatoArtifact),
		...casesFrom(
			"ondato-loop",
			loopJudge,
			assertArtifact(loopJudge, "ondato-loop-bloxley-judged.json"),
		),
		...casesFrom(
			"ondato",
			groundingJudge,
			artifactFrom(
				options.groundingPath,
				groundingJudge,
				"ondato-positive-negative-judged.json",
			),
		),
	];
	const outputs = new Map<string, CapturedOutput>();
	const result = await Eval<ReplayCase, CapturedOutput>(
		"company-judge-replay",
		{
			data: cases.map((testCase) => ({ input: testCase, id: testCase.id })),
			task: async (input) => {
				const output = {
					verdict: input.verdict,
					decision: input.actualDecision,
				};
				outputs.set(input.id, output);
				return output;
			},
			scores: [
				({ input, output }) => ({
					name: "independent_decision",
					score: output ? scoreCase(input, output).score : 0,
				}),
			],
			metadata: { source: "saved judge outputs", invokesModel: false },
		},
		{ noSendLogs: true },
	);
	let allPass = true;
	for (const testCase of cases) {
		const output = outputs.get(testCase.id);
		if (!output) throw new Error(`Eval produced no output for ${testCase.id}`);
		const scored = scoreCase(testCase, output);
		allPass &&= scored.score === 1;
		console.log(
			`${testCase.id}: ${scored.score === 1 ? "PASS" : "FAIL"} (${scored.reason})`,
		);
	}
	console.log(
		`company-judge-replay: ${allPass ? "PASS" : "FAIL"}; cases=${cases.length}; braintrustSent=false; experiment=${result.summary.experimentUrl ?? "local"}`,
	);
	return allPass;
}

if (import.meta.main)
	process.exitCode = (await runCompanyJudgeReplay({
		form3Path: cliPath("--form3-output"),
		ondatoPath: cliPath("--ondato-output"),
		groundingPath: cliPath("--grounding-output"),
	}))
		? 0
		: 1;
