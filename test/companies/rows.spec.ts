import { describe, expect, it } from "vitest";
import type { FindCompaniesReject } from "@/core/companies/candidates";
import {
	roundRefusalsEvidenceRow,
	roundTimingsEvidenceRow,
} from "@/core/companies/rows";

function judgeReject(
	overrides: Partial<FindCompaniesReject> = {},
): FindCompaniesReject {
	return {
		domain: "refused.com",
		reason: "contradicts r1: sells only to consumers",
		stage: "judge",
		statuses: [{ id: "r1", status: "contradicted" }],
		...overrides,
	};
}

describe("roundTimingsEvidenceRow", () => {
	it("carries every dependency's seconds for the round as one run-level row", () => {
		const row = roundTimingsEvidenceRow("run-1", 2, [
			{ dep: "search", seconds: 1.5 },
			{ dep: "judge", seconds: 20 },
		]);
		expect(row?.subjectType).toBe("run");
		expect(row?.kind).toBe("round-timings");
		expect(JSON.parse(row?.value ?? "")).toEqual({
			runId: "run-1",
			round: 2,
			timings: [
				{ dep: "search", seconds: 1.5 },
				{ dep: "judge", seconds: 20 },
			],
		});
	});

	it("is null when nothing was timed", () => {
		expect(roundTimingsEvidenceRow("run-1", 1, [])).toBeNull();
	});
});

describe("roundRefusalsEvidenceRow", () => {
	it("carries every refused row's domain, reason and the judge's statuses", () => {
		const row = roundRefusalsEvidenceRow("companies_icp-1_2026-09-03", 2, [
			judgeReject(),
		]);

		expect(row?.subjectType).toBe("run");
		expect(row?.subjectId).toBe("companies_icp-1_2026-09-03");
		expect(row?.kind).toBe("round-refusals");
		const parsed: unknown = JSON.parse(String(row?.value));
		expect(parsed).toEqual({
			runId: "companies_icp-1_2026-09-03",
			round: 2,
			refused: [
				{
					domain: "refused.com",
					reason: "contradicts r1: sells only to consumers",
					statuses: [{ id: "r1", status: "contradicted" }],
				},
			],
		});
	});

	it("drops a reject the judge never produced, since it carries no statuses to report, and reports null for a round that refused nothing", () => {
		const noStatuses = roundRefusalsEvidenceRow("run-1", 1, [
			{ domain: "a.com", reason: "missing-required", stage: "filter" },
		]);
		expect(noStatuses).toBeNull();

		expect(roundRefusalsEvidenceRow("run-1", 1, [])).toBeNull();
	});

	it("bounds the stored value to 20 KB even for a very large refusal list", () => {
		const rejects = Array.from({ length: 2000 }, (_unused, index) =>
			judgeReject({ domain: `refused-${index}.com` }),
		);

		const row = roundRefusalsEvidenceRow("run-1", 1, rejects);

		expect(row?.value.length).toBeLessThanOrEqual(20_000);
	});
});
