import { describe, expect, it } from "vitest";
import type { FindCompaniesReject } from "../src/core/companies/candidates";
import { roundRefusalsEvidenceRow } from "../src/core/companies/rows";

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

	it("drops a reject the judge never produced, since it carries no statuses to report", () => {
		const row = roundRefusalsEvidenceRow("run-1", 1, [
			{ domain: "a.com", reason: "missing-required", stage: "filter" },
		]);

		expect(row).toBeNull();
	});

	it("is null for a round that refused nothing at the judge", () => {
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
