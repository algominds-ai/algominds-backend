#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "test", "build", "scripts"];
const SELF = "scripts/check-language.mjs";
const EXT = /\.(ts|tsx|mts|cts|mjs|js)$/;

const BANNED = [
	{ re: /\bKTD\s?\d+\b/g, why: "planning-decision id" },
	{ re: /\bAE\s?\d+\b/g, why: "acceptance-example id" },
	{ re: /\bR\d+\b(?=\s|[.,)'"`]|$)/g, why: "requirement id" },
	{ re: /\bU\d+\b(?=\s|[.,)'"`]|$)/g, why: "implementation-unit id" },
	{ re: /\b(milestone|sub-?phase)\b/gi, why: "planning vocabulary" },
	{ re: /\bphase\s?\d+\b/gi, why: "planning vocabulary" },
	{
		re: /\b(acceptance example|implementation unit|the plan says)\b/gi,
		why: "planning vocabulary",
	},
	{ re: /\b(per|see|refer to) the plan\b/gi, why: "planning reference" },
	{ re: /\bguard\b(?=[^\w]*$)/gi, why: "plan-trace phrasing" },
];

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (EXT.test(name)) out.push(p);
	}
	return out;
}

function collectFiles() {
	const files = [];
	for (const root of ROOTS) {
		try {
			files.push(...walk(root));
		} catch {
			files.push();
		}
	}
	return files;
}

function scan(file) {
	const found = [];
	const lines = readFileSync(file, "utf8").split("\n");
	for (const [index, text] of lines.entries()) {
		for (const { re, why } of BANNED) {
			re.lastIndex = 0;
			const match = re.exec(text);
			if (match) found.push({ line: index + 1, token: match[0], why });
		}
	}
	return found;
}

let failed = 0;
for (const file of collectFiles()) {
	if (relative(".", file) === SELF) continue;
	for (const hit of scan(file)) {
		console.error(
			`${relative(".", file)}:${hit.line}  "${hit.token}" is a ${hit.why} — say what the code does, not which plan entry it traces to`,
		);
		failed++;
	}
}
if (failed > 0) {
	console.error(
		`\n${failed} planning reference(s) in code. Names and docstrings describe behaviour, never the plan.`,
	);
	process.exit(1);
}
console.log("check-language: clean");
