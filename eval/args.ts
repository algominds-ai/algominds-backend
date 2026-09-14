import { parseArgs } from "node:util";
import { SuiteSchema } from "@eval/schema";
import { z } from "zod";

export function options(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			case: { type: "string" },
			stage: { type: "string", default: "engine" },
			local: { type: "boolean", default: false },
			profile: { type: "string" },
			trials: { type: "string", default: "2" },
			port: { type: "string", default: "8787" },
			version: { type: "string" },
			baseline: { type: "string" },
			timeout: { type: "string", default: "1200" },
			"max-spend": { type: "string", default: "8" },
			"code-only": { type: "boolean", default: false },
		},
	});
	if (positionals.length !== 1)
		throw new Error(
			"usage: bun run eval <onboarding|company|people> [--profile slug] [--trials 2] [--version snapshot] [--baseline experiment] [--max-spend 8]",
		);
	return {
		suite: SuiteSchema.parse(positionals[0]),
		stage: z
			.enum([
				"engine",
				"extraction",
				"synthesis",
				"judging",
				"prefilter",
				"verification",
			])
			.parse(values.stage),
		local: values.local,
		profile: values.profile,
		caseId: values.case,
		trials: z.coerce.number().int().min(1).max(20).parse(values.trials),
		port: z.coerce.number().int().min(1024).max(65535).parse(values.port),
		timeout: z.coerce.number().int().min(1).max(3600).parse(values.timeout),
		maxSpend: z.coerce.number().positive().parse(values["max-spend"]),
		version: values.version,
		baseline: values.baseline,
		codeOnly: values.local || values["code-only"],
	};
}
