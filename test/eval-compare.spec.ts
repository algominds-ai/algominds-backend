import type { ExperimentProfileSnapshot } from "@eval/compare";
import {
	diffProfiles,
	formatComparison,
	snapshotsFromRows,
} from "@eval/compare";
import { describe, expect, it } from "vitest";

function snapshot(
	overrides: Partial<ExperimentProfileSnapshot> = {},
): ExperimentProfileSnapshot {
	return {
		profile: "mstone",
		count: 3,
		costDollars: 0.9,
		seconds: 90,
		qualifiedCoverage: 0.5,
		domains: ["a.com", "b.com", "c.com"],
		...overrides,
	};
}

describe("diffProfiles", () => {
	it("computes coverage, cost and seconds per company against the matching previous profile", () => {
		const [result] = diffProfiles(
			[snapshot()],
			[snapshot({ costDollars: 0.6, qualifiedCoverage: 0.25 })],
		);
		expect(result?.coverage).toEqual({
			current: 0.5,
			previous: 0.25,
			diff: 0.25,
		});
		expect(result?.costPerCompany.current).toBeCloseTo(0.3);
		expect(result?.costPerCompany.previous).toBeCloseTo(0.2);
	});

	it("compares against nulls when the profile has no previous snapshot", () => {
		const [result] = diffProfiles([snapshot()], []);
		expect(result?.coverage).toEqual({
			current: 0.5,
			previous: null,
			diff: null,
		});
		expect(result?.appeared).toEqual(["a.com", "b.com", "c.com"]);
		expect(result?.disappeared).toEqual([]);
	});

	it("reports which companies appeared and disappeared between the two snapshots", () => {
		const [result] = diffProfiles(
			[snapshot({ domains: ["a.com", "d.com"] })],
			[snapshot({ domains: ["a.com", "b.com"] })],
		);
		expect(result?.appeared).toEqual(["d.com"]);
		expect(result?.disappeared).toEqual(["b.com"]);
	});
});

describe("snapshotsFromRows", () => {
	it("folds the root companies-run row and every company span into one snapshot per profile", () => {
		const rows = [
			{
				span_attributes: { name: "companies-run" },
				metadata: {
					profile: "mstone",
					count: 2,
					costDollars: 0.5,
					seconds: 60,
				},
				scores: { qualified_coverage: 0.5 },
			},
			{
				span_attributes: { name: "company-a.com" },
				metadata: { profile: "mstone" },
			},
			{
				span_attributes: { name: "company-b.com" },
				metadata: { profile: "mstone" },
			},
			{
				span_attributes: { name: "round-1" },
				metadata: { profile: "mstone" },
			},
		];
		const [snap] = snapshotsFromRows(rows);
		expect(snap).toEqual({
			profile: "mstone",
			count: 2,
			costDollars: 0.5,
			seconds: 60,
			qualifiedCoverage: 0.5,
			domains: ["a.com", "b.com"],
		});
	});

	it("skips a row that carries no profile in its metadata", () => {
		expect(
			snapshotsFromRows([{ span_attributes: { name: "company-a.com" } }]),
		).toEqual([]);
	});
});

describe("formatComparison", () => {
	it("says there is nothing to compare when there is no previous experiment", () => {
		expect(
			formatComparison({ previousExperiment: null, profiles: [] }),
		).toMatch(/no previous experiment/);
	});

	it("prints coverage, cost, seconds and the appeared/disappeared companies per profile", () => {
		const text = formatComparison({
			previousExperiment: "abc-baseline",
			profiles: diffProfiles(
				[snapshot({ domains: ["a.com", "d.com"] })],
				[snapshot({ domains: ["a.com", "b.com"] })],
			),
		});
		expect(text).toContain("abc-baseline");
		expect(text).toContain("mstone:");
		expect(text).toContain("appeared: d.com");
		expect(text).toContain("disappeared: b.com");
	});
});
