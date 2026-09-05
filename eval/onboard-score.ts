import type { IcpDoc } from "@eval/icp-doc";
import type { Requirement } from "@/core/requirements";

export type WrittenOnboardProfile = {
	description: string;
	requirements: readonly Requirement[];
	buyer: { rubric: string } | null;
};

export type OnboardCheck = { name: string; passed: boolean };

const BOUND_RE = /\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d+(?:\.\d+)?[MBK]\b/gi;
const BANNED_STEMS = ["announc", "launch", "rais", "complain", "review"];

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

function checkNoBannedWords(writtenHard: readonly Requirement[]): OnboardCheck {
	const offenders = writtenHard.filter((req) => hasBannedWord(req.text));
	return {
		name: "no written hard requirement carries a bonus-only word",
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

export function scoreOnboardProfile(
	written: WrittenOnboardProfile,
	fixture: IcpDoc,
): OnboardCheck[] {
	const fixtureHard = hardRequirementsOf(fixture.requirements ?? []);
	const writtenHard = hardRequirementsOf(written.requirements);
	return [
		{
			name: "description is at most 1000 characters",
			passed: written.description.length <= 1000,
		},
		{
			name: "written hard requirement count is at most five",
			passed: writtenHard.length <= 5,
		},
		checkNoBannedWords(writtenHard),
		...checkBoundsCovered(fixtureHard, writtenHard),
		{
			name: "buyer rubric is at most 400 characters",
			passed: written.buyer !== null && written.buyer.rubric.length <= 400,
		},
	];
}

export function formatCheckLine(check: OnboardCheck): string {
	return `${check.passed ? "PASS" : "FAIL"}  ${check.name}`;
}

export function summaryLine(checks: readonly OnboardCheck[]): string {
	const passed = checks.filter((check) => check.passed).length;
	return `${passed} of ${checks.length}`;
}
