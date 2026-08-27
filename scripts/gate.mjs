#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const STEPS = [
	["config", "bun", ["scripts/config-gen.mjs", "--check"]],
	["types", "bunx", ["tsc", "--noEmit"]],
	["biome", "bunx", ["biome", "check", "."]],
	["comments", "bun", ["scripts/check-comments.mjs"]],
	["language", "bun", ["scripts/check-language.mjs"]],
	["tests", "bunx", ["vitest", "run"]],
	["bundle", "bunx", ["wrangler", "deploy", "--dry-run"]],
];

const failures = [];
for (const [name, cmd, args] of STEPS) {
	process.stdout.write(`\n──── ${name} ────\n`);
	const run = spawnSync(cmd, args, { stdio: "inherit" });
	if (run.status !== 0) failures.push(name);
}

process.stdout.write("\n════ gate ════\n");
for (const [name] of STEPS) {
	process.stdout.write(
		`${failures.includes(name) ? "FAIL" : "pass"}  ${name}\n`,
	);
}
if (failures.length > 0) {
	process.stdout.write(`\ngate FAILED: ${failures.join(", ")}\n`);
	process.exit(1);
}
process.stdout.write("\ngate PASSED\n");
