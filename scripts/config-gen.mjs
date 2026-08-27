import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "config.yaml";
const TARGET = "src/config.ts";

function format(source) {
	const run = spawnSync(
		"bunx",
		["biome", "format", `--stdin-file-path=${TARGET}`],
		{ input: source, encoding: "utf8" },
	);
	if (run.status !== 0) {
		console.error(run.stderr || "biome format failed");
		process.exit(1);
	}
	return run.stdout;
}

function build() {
	const parsed = Bun.YAML.parse(readFileSync(SOURCE, "utf8"));
	const body = JSON.stringify(parsed, null, "\t");
	return format(
		[
			"/** Generated from config.yaml. Edit that file, then run `bun run config`. */",
			`export const config = ${body} as const;`,
			"",
		].join("\n"),
	);
}

const generated = build();
const current = (() => {
	try {
		return readFileSync(TARGET, "utf8");
	} catch {
		return "";
	}
})();

if (process.argv.includes("--check")) {
	if (current !== generated) {
		console.error(`${TARGET} is stale. Run \`bun run config\`.`);
		process.exit(1);
	}
	console.log(`${TARGET} matches ${SOURCE}`);
} else {
	writeFileSync(TARGET, generated);
	console.log(`wrote ${TARGET} from ${SOURCE}`);
}
