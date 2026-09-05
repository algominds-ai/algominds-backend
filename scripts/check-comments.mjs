#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "test", "build", "scripts", "eval"];
const GENERATED = ["src/core/db/auth-schema.ts", "src/config.ts"];
const EXT = /\.(ts|tsx|mts|cts|mjs|js)$/;

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (EXT.test(name)) out.push(p);
	}
	return out;
}

function skipQuoted(src, start, terminator) {
	let i = start + 1;
	let lines = 0;
	while (i < src.length) {
		if (src[i] === "\\") i += 2;
		else if (src[i] === terminator) return { next: i + 1, lines };
		else {
			if (src[i] === "\n") lines++;
			i++;
		}
	}
	return { next: i, lines };
}

function skipLineComment(src, start) {
	let i = start;
	while (i < src.length && src[i] !== "\n") i++;
	return { next: i, lines: 0, hit: "line" };
}

function skipBlockComment(src, start) {
	let i = start + 2;
	let lines = 0;
	while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
		if (src[i] === "\n") lines++;
		i++;
	}
	const hit = src[start + 2] === "*" ? undefined : "block";
	return { next: i + 2, lines, hit };
}

function stepAt(src, i) {
	const c = src[i];
	if (c === "\n") return { next: i + 1, lines: 1 };
	if (c === '"' || c === "'" || c === "`") return skipQuoted(src, i, c);
	if (c !== "/") return { next: i + 1, lines: 0 };
	if (src[i + 1] === "/") return skipLineComment(src, i);
	if (src[i + 1] === "*") return skipBlockComment(src, i);
	return { next: i + 1, lines: 0 };
}

function findComments(src) {
	const hits = [];
	let line = 1;
	let i = 0;
	while (i < src.length) {
		const step = stepAt(src, i);
		if (step.hit) hits.push({ line, kind: step.hit });
		line += step.lines;
		i = step.next;
	}
	return hits;
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

let failed = 0;
for (const file of collectFiles()) {
	if (GENERATED.includes(relative(".", file))) continue;
	for (const hit of findComments(readFileSync(file, "utf8"))) {
		console.error(
			`${relative(".", file)}:${hit.line}  ${hit.kind} comment — rename until the code says it, or put the explanation in docs/solutions/`,
		);
		failed++;
	}
}
if (failed > 0) {
	console.error(
		`\n${failed} banned comment(s). Only /** */ docstrings are allowed.`,
	);
	process.exit(1);
}
console.log("check-comments: clean");
