import type { IcpDoc } from "@eval/icp-doc";
import type { Requirement } from "@/core/requirements";

export type WrittenOnboardProfile = {
	description: string;
	requirements: readonly Requirement[];
	buyer: { rubric: string } | null;
};

export type OnboardCheck = { name: string; passed: boolean };

const STOP_WORDS = new Set([
	"should",
	"because",
	"within",
	"without",
	"through",
	"having",
	"unless",
	"either",
	"neither",
	"however",
	"between",
	"before",
	"during",
	"against",
	"cannot",
	"though",
	"beyond",
	"itself",
	"people",
	"record",
	"country",
]);

const BOUND_RE = /\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d+(?:\.\d+)?[MBK]\b/gi;
const BANNED_STEMS = ["announc", "launch", "rais", "complain", "review"];

function distinctiveWords(text: string): Set<string> {
	const found = text.toLowerCase().match(/[a-z]+/g) ?? [];
	return new Set(
		found.filter((word) => word.length > 5 && !STOP_WORDS.has(word)),
	);
}

function sharesTwoDistinctiveWords(a: string, b: string): boolean {
	const wordsA = distinctiveWords(a);
	const wordsB = distinctiveWords(b);
	let shared = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) shared++;
	}
	return shared >= 2;
}

export function hardRequirementsOf(
	requirements: readonly Requirement[],
): Requirement[] {
	return requirements.filter((req) => req.kind === "hard");
}

function boundTokens(text: string): string[] {
	const found = text.match(BOUND_RE) ?? [];
	return found.map((token) => token.replace(/\$/g, "").toUpperCase());
}

function containsBound(text: string, token: string): boolean {
	return text.toUpperCase().replace(/\$/g, "").includes(token);
}

function hasBannedWord(text: string): boolean {
	const lower = text.toLowerCase();
	return BANNED_STEMS.some((stem) => lower.includes(stem));
}

function extractTitles(rubric: string): string[] {
	return rubric
		.split(/,| or /i)
		.map((segment) => segment.trim())
		.map((segment) =>
			segment.replace(/^(the\s+buyer\s+is\s+)?(the\s+|or\s+)?/i, "").trim(),
		)
		.map((segment) => segment.replace(/\s+at a company.*$/i, "").trim())
		.map((segment) => segment.replace(/[.,;:]+$/, "").trim())
		.filter((segment) => segment.length > 0 && /^[A-Z]/.test(segment));
}

function checkHardCoverage(
	fixtureHard: readonly Requirement[],
	writtenHard: readonly Requirement[],
): OnboardCheck[] {
	return fixtureHard.map((req) => ({
		name: `fixture hard requirement ${req.id} has a matching written hard requirement`,
		passed: writtenHard.some((written) =>
			sharesTwoDistinctiveWords(req.text, written.text),
		),
	}));
}

function checkNoWindowOrBannedWords(
	writtenHard: readonly Requirement[],
): OnboardCheck {
	const offenders = writtenHard.filter(
		(req) => req.windowDays !== null || hasBannedWord(req.text),
	);
	return {
		name: "no written hard requirement carries a window or a bonus-only word",
		passed: offenders.length === 0,
	};
}

function checkBoundsCovered(
	fixtureHard: readonly Requirement[],
	writtenHard: readonly Requirement[],
): OnboardCheck[] {
	const bounds = new Set<string>();
	for (const req of fixtureHard) {
		for (const token of boundTokens(req.text)) bounds.add(token);
	}
	return Array.from(bounds).map((token) => ({
		name: `numeric bound ${token} appears in a written hard requirement`,
		passed: writtenHard.some((written) => containsBound(written.text, token)),
	}));
}

function checkBuyerTitlesCovered(
	fixtureRubric: string,
	writtenRubric: string,
): OnboardCheck[] {
	return extractTitles(fixtureRubric).map((title) => ({
		name: `buyer rubric mentions the title ${title}`,
		passed: writtenRubric.toLowerCase().includes(title.toLowerCase()),
	}));
}

export function scoreOnboardProfile(
	written: WrittenOnboardProfile,
	fixture: IcpDoc,
): OnboardCheck[] {
	const fixtureHard = hardRequirementsOf(fixture.requirements ?? []);
	const writtenHard = hardRequirementsOf(written.requirements);
	const fixtureRubric = fixture.buyer?.rubric ?? "";
	const writtenRubric = written.buyer?.rubric ?? "";
	return [
		{
			name: "description is at most 1000 characters",
			passed: written.description.length <= 1000,
		},
		{
			name: "written hard requirement count is at most five",
			passed: writtenHard.length <= 5,
		},
		...checkHardCoverage(fixtureHard, writtenHard),
		checkNoWindowOrBannedWords(writtenHard),
		...checkBoundsCovered(fixtureHard, writtenHard),
		{
			name: "buyer rubric is at most 400 characters",
			passed: written.buyer !== null && written.buyer.rubric.length <= 400,
		},
		...checkBuyerTitlesCovered(fixtureRubric, writtenRubric),
	];
}

export function formatCheckLine(check: OnboardCheck): string {
	return `${check.passed ? "PASS" : "FAIL"}  ${check.name}`;
}

export function summaryLine(checks: readonly OnboardCheck[]): string {
	const passed = checks.filter((check) => check.passed).length;
	return `${passed} of ${checks.length}`;
}
