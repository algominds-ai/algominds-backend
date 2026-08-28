#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/workflows";
const CALL = /(?:^|[^\w.])(?:ctx\.)?step\.do\(/;
const CONFIG = /config\.stepConfig\.(paidCall|databaseCall)\b/;
const LOOKAHEAD = 3;

const failures = [];

for (const name of readdirSync(ROOT)) {
	if (!name.endsWith(".ts")) continue;
	const path = join(ROOT, name);
	const lines = readFileSync(path, "utf8").split("\n");
	lines.forEach((line, index) => {
		if (!CALL.test(line)) return;
		const window = lines.slice(index, index + LOOKAHEAD).join("\n");
		if (CONFIG.test(window)) return;
		failures.push(
			`${path}:${index + 1}  step.do without a retry and timeout budget`,
		);
	});
}

for (const failure of failures) console.error(failure);

if (failures.length > 0) {
	console.error(
		`\n${failures.length} unbudgeted step(s). Cloudflare defaults to 5 retries, so a paid call would be billed five times.`,
	);
	process.exit(1);
}
console.log("every workflow step carries a retry and timeout budget");
