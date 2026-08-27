#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "test", "build", "scripts"];
const EXT = /\.(ts|tsx|mts|cts|mjs|js)$/;

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (EXT.test(name)) out.push(p);
	}
	return out;
}

function findComments(src) {
	const hits = [];
	let line = 1;
	let i = 0;
	let quote = null;
	let template = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "\n") line++;
		if (quote) {
			if (c === "\\") i += 2;
			else {
				if (c === quote) quote = null;
				i++;
			}
			continue;
		}
		if (template > 0) {
			if (c === "\\") i += 2;
			else {
				if (c === "`") template--;
				i++;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			i++;
			continue;
		}
		if (c === "`") {
			template++;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			hits.push({ line, kind: "line" });
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			const jsdoc = src[i + 2] === "*";
			if (!jsdoc) hits.push({ line, kind: "block" });
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
				if (src[i] === "\n") line++;
				i++;
			}
			i += 2;
			continue;
		}
		i++;
	}
	return hits;
}

let failed = 0;
for (const root of ROOTS) {
	let files = [];
	try {
		files = walk(root);
	} catch {
		continue;
	}
	for (const file of files) {
		for (const hit of findComments(readFileSync(file, "utf8"))) {
			console.error(
				`${relative(".", file)}:${hit.line}  ${hit.kind} comment — rename until the code says it, or put the explanation in docs/solutions/`,
			);
			failed++;
		}
	}
}
if (failed > 0) {
	console.error(`\n${failed} banned comment(s). Only /** */ docstrings are allowed.`);
	process.exit(1);
}
console.log("check-comments: clean");
