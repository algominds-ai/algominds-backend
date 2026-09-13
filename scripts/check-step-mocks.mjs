#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = "src/workflows";
const TESTS = "test";
const STEP_CALL =
	/step\.do\(\s*(?:`([^`]*)`|"([^"]*)"|([A-Z_][A-Z0-9_]*|[A-Za-z_$][\w$]*\.[\w$]+))/g;
const MOCK_CALL =
	/mockStep(?:Result|Error)\(\s*\{\s*name:\s*(?:`([^`]*)`|"([^"]*)"|([A-Za-z_$][\w$]*\.[\w$]+))/g;

function sources(dir, suffix) {
	return readdirSync(dir, { recursive: true })
		.filter((name) => name.endsWith(suffix))
		.map((name) => [join(dir, name), readFileSync(join(dir, name), "utf8")]);
}

function constantValues(text) {
	const found = new Map();
	for (const block of text.matchAll(/=\s*\{([^}]*)\}\s*as const/g)) {
		for (const entry of block[1].matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) {
			found.set(entry[1], entry[2]);
		}
	}
	return found;
}

const literals = new Set();
const patterns = [];
const constants = new Map();

/** A step template compiled to a pattern, with each interpolation standing for one name segment. */
function templatePattern(template) {
	const parts = template.split(/\$\{[^}]*\}/g).map(escapeLiteral);
	return new RegExp(`^${parts.join("[A-Za-z0-9_]+")}$`);
}

function escapeLiteral(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const [, text] of sources(WORKFLOWS, ".ts")) {
	for (const [key, value] of constantValues(text)) constants.set(key, value);
	for (const call of text.matchAll(STEP_CALL)) {
		const [, template, quoted, identifier] = call;
		if (quoted) literals.add(quoted);
		else if (template) {
			if (template.includes("${")) patterns.push(templatePattern(template));
			else literals.add(template);
		} else if (identifier) {
			const value = constants.get(identifier.split(".").pop());
			if (value) literals.add(value);
		}
	}
}

const failures = [];
for (const [path, text] of sources(TESTS, ".ts")) {
	for (const call of text.matchAll(MOCK_CALL)) {
		const [, template, quoted, identifier] = call;
		if (identifier) continue;
		const name = quoted ?? template;
		if (!name || name.includes("${")) continue;
		const known =
			literals.has(name) || patterns.some((pattern) => pattern.test(name));
		if (!known) {
			const line = text.slice(0, call.index).split("\n").length;
			failures.push(
				`${path}:${line}  mocks a step no workflow runs: "${name}"`,
			);
		}
	}
}

for (const failure of failures) console.error(failure);
if (failures.length > 0) {
	console.error(
		`\n${failures.length} orphaned step mock(s). A mock keyed to a name nothing runs is a silent no-op, so a paid step it was meant to intercept runs for real.`,
	);
	process.exit(1);
}
console.log("every mocked step name matches a step a workflow runs");
