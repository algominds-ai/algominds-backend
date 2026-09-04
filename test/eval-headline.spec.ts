import type {
	RunReport,
	StoredCompanyRecord,
	VerdictInput,
} from "@eval/headline";
import {
	canonicalDomain,
	compareVerdicts,
	computeVerdict,
} from "@eval/headline";
import { emptyKeyFile } from "@eval/label-core";
import type { ProfileBars } from "@eval/profiles";
import { describe, expect, it } from "vitest";

const BARS: ProfileBars = { maxCostDollars: 2, maxSeconds: 120 };

function run(overrides: Partial<RunReport> = {}): RunReport {
	return {
		runId: "run-1",
		costDollars: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:01:00.000Z",
		...overrides,
	};
}

function company(
	overrides: Partial<StoredCompanyRecord> = {},
): StoredCompanyRecord {
	return {
		domain: "a.com",
		name: "A Inc",
		citedPage: null,
		quote: null,
		evidenceCheck: null,
		provingPageStored: false,
		...overrides,
	};
}

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
	const key = emptyKeyFile("mstone", "icp-1");
	key.companies["a.com"] = {
		label: "accept",
		name: "A Inc",
		firstSeenRunId: "run-0",
		lastSeenAt: "2025-01-01T00:00:00.000Z",
	};
	return {
		key,
		run: run(),
		bars: BARS,
		requiresProvingPass: false,
		stored: [company()],
		...overrides,
	};
}

describe("canonicalDomain", () => {
	it("follows a same-as chain to its root", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		key.companies["b.com"] = {
			label: "same-as:a.com",
			name: null,
			firstSeenRunId: "r",
			lastSeenAt: "t",
		};
		expect(canonicalDomain(key, "b.com")).toBe("a.com");
	});

	it("returns the domain itself when the key names no alias", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		expect(canonicalDomain(key, "a.com")).toBe("a.com");
	});
});

describe("computeVerdict", () => {
	it("passes every gate and reports full precision for a clean, on-budget run", () => {
		const verdict = computeVerdict(input());
		expect(verdict.allGatesPass).toBe(true);
		expect(verdict.precision).toBe(1);
		expect(verdict.costPerStoredCompany).toBe(1);
		expect(verdict.secondsPerStoredCompany).toBe(60);
	});

	it("fails noKeyRejectedStored when a stored company is a key reject", () => {
		const built = input();
		built.key.companies["a.com"] = {
			label: "reject:not-a-company",
			name: "A Inc",
			firstSeenRunId: "run-0",
			lastSeenAt: "t",
		};
		const verdict = computeVerdict(built);
		expect(verdict.gates.noKeyRejectedStored).toBe(false);
		expect(verdict.allGatesPass).toBe(false);
	});

	it("fails noDuplicateOrganisationGroup when two stored domains share a canonical root", () => {
		const built = input();
		built.key.companies["b.com"] = {
			label: "same-as:a.com",
			name: null,
			firstSeenRunId: "run-0",
			lastSeenAt: "t",
		};
		built.stored = [company({ domain: "a.com" }), company({ domain: "b.com" })];
		const verdict = computeVerdict(built);
		expect(verdict.gates.noDuplicateOrganisationGroup).toBe(false);
	});

	it("fails recordBoundsHold when a stored company carries no name", () => {
		const built = input();
		built.stored = [company({ name: null })];
		expect(computeVerdict(built).gates.recordBoundsHold).toBe(false);
	});

	it("requires a citation, a found check and a stored proving page only when the profile demands proof", () => {
		const built = input({ requiresProvingPass: true });
		const withoutProof = computeVerdict(built);
		expect(withoutProof.gates.provingPassesWhereRequired).toBe(false);
		built.stored = [
			company({
				citedPage: "https://a.com/blog",
				evidenceCheck: "found",
				provingPageStored: true,
			}),
		];
		expect(computeVerdict(built).gates.provingPassesWhereRequired).toBe(true);
	});

	it("fails costUnderBar and secondsUnderBar past the profile's own bars", () => {
		const overBudget = computeVerdict(input({ run: run({ costDollars: 5 }) }));
		expect(overBudget.gates.costUnderBar).toBe(false);
		const overTime = computeVerdict(
			input({ run: run({ finishedAt: "2026-01-01T01:00:00.000Z" }) }),
		);
		expect(overTime.gates.secondsUnderBar).toBe(false);
	});

	it("counts an unlabelled stored company without failing a gate", () => {
		const built = input();
		built.stored = [
			company({ domain: "a.com" }),
			company({ domain: "unseen.com" }),
		];
		const verdict = computeVerdict(built);
		expect(verdict.unlabelledStoredCount).toBe(1);
		expect(verdict.allGatesPass).toBe(true);
	});

	it("reports precision as accepted over labelled stored companies, ignoring unlabelled ones", () => {
		const built = input();
		built.key.companies["b.com"] = {
			label: "reject:not-a-company",
			name: "B",
			firstSeenRunId: "run-0",
			lastSeenAt: "t",
		};
		built.stored = [
			company({ domain: "a.com" }),
			company({ domain: "b.com" }),
			company({ domain: "unseen.com" }),
		];
		expect(computeVerdict(built).precision).toBe(0.5);
	});

	it("reports null precision when no stored company is labelled yet", () => {
		const built = input();
		built.stored = [company({ domain: "unseen.com" })];
		expect(computeVerdict(built).precision).toBeNull();
	});
});

describe("compareVerdicts", () => {
	it("ranks every gate passing above any gate failing, regardless of cost", () => {
		const clean = computeVerdict(input());
		const dirty = computeVerdict(input({ run: run({ costDollars: 5 }) }));
		expect(compareVerdicts(clean, dirty)).toBeLessThan(0);
	});

	it("breaks a tie on gates by lower cost per company, then fewer seconds", () => {
		const slower = computeVerdict(
			input({ run: run({ finishedAt: "2026-01-01T00:01:30.000Z" }) }),
		);
		expect(compareVerdicts(computeVerdict(input()), slower)).toBeLessThan(0);

		const cheaper = computeVerdict(input({ run: run({ costDollars: 0.5 }) }));
		const pricier = computeVerdict(input({ run: run({ costDollars: 1.5 }) }));
		expect(compareVerdicts(cheaper, pricier)).toBeLessThan(0);
	});
});
