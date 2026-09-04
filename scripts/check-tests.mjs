#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "test";
const SUPPORT_PREFIX = "test/support/";
const ALLOWED_ROOT_FILES = new Set([
	"test/global-setup.ts",
	"test/raw-import.d.ts",
]);
const STRICT = process.argv.includes("--strict");
const MAX_SPEC_LINES = 300;
const MAX_TEST_LINES = 40;

const FAKE_DEFINITION =
	/\b(?:function|const)\s+(fake|mock|stub)[A-Za-z0-9_]*\s*[(=]/;
const VI_FN_OR_STUB_GLOBAL = /\bvi\.fn\(|\bstubGlobal\(/;
const SECRET_BINDING_LITERAL = /\bget:\s*async\b/;
const PROVIDER_IMPORT =
	/from\s+["'](?:@\/core\/providers|\.\.\/src\/core\/providers)[^"']*["']/;
const CALLED_WITH_ON_FETCH = /\.toHaveBeenCalledWith\(/;
const PLANNING_ID = /\b[RUK]?[A-Z]{1,3}\d{1,3}\b/;
const PLAN_WORDS = /\b(should|correctly|properly|works)\b/i;
const TEST_CALL = /\b(?:it|test)\(/g;
const TEST_NAME = /\b(?:it|test)\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.ts$/.test(name)) out.push(p);
	}
	return out;
}

function isSpec(path) {
	return path.endsWith(".spec.ts");
}

function isSupport(path) {
	return relative(".", path).startsWith(SUPPORT_PREFIX);
}

function lineAt(text, index) {
	return text.slice(0, index).split("\n").length;
}

function countNonBlankLines(lines) {
	return lines.filter((line) => line.trim() !== "").length;
}

function findMatchingBrace(text, openIndex) {
	let depth = 0;
	let i = openIndex;
	while (i < text.length) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return -1;
}

function testBodies(text) {
	const bodies = [];
	TEST_CALL.lastIndex = 0;
	let match = TEST_CALL.exec(text);
	while (match) {
		const openBrace = text.indexOf("{", match.index);
		const nextCall = text.indexOf("(", match.index + match[0].length);
		if (openBrace !== -1 && (nextCall === -1 || openBrace < nextCall + 200)) {
			const close = findMatchingBrace(text, openBrace);
			if (close !== -1) {
				bodies.push({
					start: match.index,
					body: text.slice(openBrace + 1, close),
				});
			}
		}
		match = TEST_CALL.exec(text);
	}
	return bodies;
}

function normalizeBody(body) {
	return body.replace(/\s+/g, " ").trim();
}

function ruleOversizedSpec(path, text, findings) {
	const lines = text.split("\n");
	const nonBlank = countNonBlankLines(lines);
	if (nonBlank > MAX_SPEC_LINES) {
		findings.push({
			rule: 1,
			path,
			line: 1,
			reason: `spec has ${nonBlank} lines, over the ${MAX_SPEC_LINES} limit`,
		});
	}
}

function ruleOversizedTest(path, text, findings) {
	for (const { start, body } of testBodies(text)) {
		const bodyLines = countNonBlankLines(body.split("\n"));
		if (bodyLines > MAX_TEST_LINES) {
			findings.push({
				rule: 2,
				path,
				line: lineAt(text, start),
				reason: `test body has ${bodyLines} lines, over the ${MAX_TEST_LINES} limit`,
			});
		}
	}
}

function ruleFakeOutsideSupport(path, text, findings) {
	if (isSupport(path)) return;
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		const named = FAKE_DEFINITION.exec(line);
		if (named) {
			findings.push({
				rule: 3,
				path,
				line: index + 1,
				reason: `defines ${named[0].trim()} outside test/support/`,
			});
		}
		if (VI_FN_OR_STUB_GLOBAL.test(line)) {
			findings.push({
				rule: 3,
				path,
				line: index + 1,
				reason: "calls vi.fn/stubGlobal outside test/support/",
			});
		}
		if (SECRET_BINDING_LITERAL.test(line)) {
			findings.push({
				rule: 3,
				path,
				line: index + 1,
				reason: "defines a secret-binding fake outside test/support/",
			});
		}
	});
}

function ruleMockShapeAssertion(path, text, findings) {
	if (relative(".", path).startsWith("test/providers/")) return;
	if (!PROVIDER_IMPORT.test(text)) return;
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		if (CALLED_WITH_ON_FETCH.test(line)) {
			findings.push({
				rule: 4,
				path,
				line: index + 1,
				reason:
					"asserts a mock's call shape against a provider import outside test/providers/",
			});
		}
	});
}

function rulePlanningTestName(path, text, findings) {
	TEST_NAME.lastIndex = 0;
	let match = TEST_NAME.exec(text);
	while (match) {
		const name = match[1].slice(1, -1);
		if (PLANNING_ID.test(name) || PLAN_WORDS.test(name)) {
			findings.push({
				rule: 5,
				path,
				line: lineAt(text, match.index),
				reason: `test name "${name}" carries a planning id or a vague word`,
			});
		}
		match = TEST_NAME.exec(text);
	}
}

function ruleDuplicateTestBodies(path, text, findings) {
	const seen = new Map();
	for (const { start, body } of testBodies(text)) {
		const normalized = normalizeBody(body);
		if (normalized === "") continue;
		const firstLine = seen.get(normalized);
		if (firstLine !== undefined) {
			findings.push({
				rule: 6,
				path,
				line: lineAt(text, start),
				reason: `duplicate of the test body at line ${firstLine}`,
			});
		} else {
			seen.set(normalized, lineAt(text, start));
		}
	}
}

function ruleOutsideSubjectFolder(path, findings) {
	const rel = relative(".", path);
	const inRoot = rel.split("/").length === 2;
	if (inRoot && !ALLOWED_ROOT_FILES.has(rel)) {
		findings.push({
			rule: 7,
			path,
			line: 1,
			reason: "spec sits directly under test/, not a subject folder",
		});
	}
}

function collectFindings(files) {
	const findings = [];
	for (const path of files) {
		const text = readFileSync(path, "utf8");
		ruleFakeOutsideSupport(path, text, findings);
		if (!isSpec(path)) continue;
		ruleOversizedSpec(path, text, findings);
		ruleOversizedTest(path, text, findings);
		ruleMockShapeAssertion(path, text, findings);
		rulePlanningTestName(path, text, findings);
		ruleDuplicateTestBodies(path, text, findings);
		ruleOutsideSubjectFolder(path, findings);
	}
	return findings;
}

function sourceLineCount() {
	let total = 0;
	for (const path of walk("src")) {
		total += readFileSync(path, "utf8").split("\n").length;
	}
	return total;
}

function testLineCount(files) {
	let total = 0;
	for (const path of files) {
		if (isSpec(path)) total += readFileSync(path, "utf8").split("\n").length;
	}
	return total;
}

const files = walk(ROOT);
const findings = collectFindings(files);
const warnRules = new Set(STRICT ? [] : [1, 2, 3, 4, 7]);

let failed = 0;
for (const finding of findings) {
	const level = warnRules.has(finding.rule) ? "warn" : "fail";
	console.error(
		`${level}  ${relative(".", finding.path)}:${finding.line}  rule ${finding.rule}: ${finding.reason}`,
	);
	if (level === "fail") failed++;
}

const specFiles = files.filter(isSpec);
const testCount = specFiles.reduce(
	(sum, path) => sum + testBodies(readFileSync(path, "utf8")).length,
	0,
);
const testLines = testLineCount(files);
const sourceLines = sourceLineCount();
const ratio = sourceLines === 0 ? 0 : testLines / sourceLines;

console.log(
	`\ncheck-tests: ${specFiles.length} files, ${testCount} tests, ${testLines} test lines, ${sourceLines} source lines, ratio ${ratio.toFixed(2)}`,
);

if (failed > 0) {
	console.error(`\n${failed} failing check-tests violation(s).`);
	process.exit(1);
}
console.log("check-tests: clean");
