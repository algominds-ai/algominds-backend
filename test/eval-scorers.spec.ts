import type { Verdict } from "@eval/headline";
import type { FitReading, ReadFit, UnlabelledCompany } from "@eval/scorers";
import { fitReading, gatesPass, qualifiedCoverage } from "@eval/scorers";
import { describe, expect, it } from "vitest";

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		runId: "run-1",
		gates: {
			noKeyRejectedStored: true,
			noDuplicateOrganisationGroup: true,
			provingPassesWhereRequired: true,
			recordBoundsHold: true,
			costUnderBar: true,
			secondsUnderBar: true,
		},
		allGatesPass: true,
		storedCount: 1,
		qualifiedCoverage: 1,
		unlabelledStoredCount: 0,
		costPerStoredCompany: 0.1,
		secondsPerStoredCompany: 10,
		...overrides,
	};
}

describe("gatesPass", () => {
	it("scores 1 when every gate held", () => {
		expect(
			gatesPass({ output: { verdict: verdict(), runId: "r", skipped: null } }),
		).toEqual({
			name: "gates_pass",
			score: 1,
		});
	});

	it("scores 0 when any gate failed", () => {
		const failing = verdict({ allGatesPass: false });
		expect(
			gatesPass({ output: { verdict: failing, runId: "r", skipped: null } }),
		).toEqual({
			name: "gates_pass",
			score: 0,
		});
	});

	it("is null for a trial the budget skipped", () => {
		expect(
			gatesPass({ output: { verdict: null, runId: null, skipped: "budget" } }),
		).toBeNull();
	});
});

describe("qualifiedCoverage", () => {
	it("reports the verdict's own coverage fraction", () => {
		const half = verdict({ qualifiedCoverage: 0.5 });
		expect(
			qualifiedCoverage({
				output: { verdict: half, runId: "r", skipped: null },
			}),
		).toEqual({ name: "qualified_coverage", score: 0.5 });
	});

	it("is null when the key has no accepted companies yet", () => {
		const none = verdict({ qualifiedCoverage: null });
		expect(
			qualifiedCoverage({
				output: { verdict: none, runId: "r", skipped: null },
			}),
		).toBeNull();
	});
});

const COMPANY: UnlabelledCompany = {
	domain: "a.com",
	name: "A Inc",
	description: "runs production Kubernetes",
};

function fakeReadFit(reading: FitReading): ReadFit {
	return async () => reading;
}

describe("fitReading", () => {
	it("scores fits as 1 and carries the model's own reason", async () => {
		const result = await fitReading(
			fakeReadFit({ verdict: "fits", reason: "matches the profile's shape" }),
			COMPANY,
		);
		expect(result).toEqual({
			domain: "a.com",
			score: 1,
			reason: "matches the profile's shape",
		});
	});

	it("scores does-not-fit as 0 and unclear as 0.5", async () => {
		const notFit = await fitReading(
			fakeReadFit({ verdict: "does-not-fit", reason: "wrong industry" }),
			COMPANY,
		);
		expect(notFit.score).toBe(0);
		const unclear = await fitReading(
			fakeReadFit({ verdict: "unclear", reason: "record is too thin" }),
			COMPANY,
		);
		expect(unclear.score).toBe(0.5);
	});
});
