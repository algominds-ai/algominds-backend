#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const STEPS = [
	["config", "bun", ["scripts/config-gen.mjs", "--check"]],
	["types", "bunx", ["tsc", "--noEmit"]],
	["biome", "bunx", ["biome", "check", "."]],
	["comments", "bun", ["scripts/check-comments.mjs"]],
	["language", "bun", ["scripts/check-language.mjs"]],
	["steps", "bun", ["scripts/check-step-config.mjs"]],
	["tests", "bunx", ["vitest", "run"]],
	["bundle", "bunx", ["wrangler", "deploy", "--dry-run"]],
];

const TAIL_LINES = 40;

function tail(text) {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(-TAIL_LINES)
		.join("\n");
}

const failures = new Map();
for (const [name, cmd, args] of STEPS) {
	process.stdout.write(`\n──── ${name} ────\n`);
	const run = spawnSync(cmd, args, { encoding: "utf8" });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	process.stdout.write(output);
	if (run.status !== 0) failures.set(name, output);
}

process.stdout.write("\n════ gate ════\n");
for (const [name] of STEPS) {
	process.stdout.write(`${failures.has(name) ? "FAIL" : "pass"}  ${name}\n`);
}
if (failures.size === 0) {
	process.stdout.write("\ngate PASSED\n");
	process.exit(0);
}
for (const [name, output] of failures) {
	process.stdout.write(
		`\n──── why ${name} failed (last ${TAIL_LINES} lines) ────\n`,
	);
	process.stdout.write(`${tail(output)}\n`);
}
process.stdout.write(`\ngate FAILED: ${[...failures.keys()].join(", ")}\n`);
process.exit(1);
