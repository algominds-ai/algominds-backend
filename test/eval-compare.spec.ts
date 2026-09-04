import { formatComparison } from "@eval/compare";
import { describe, expect, it } from "vitest";

describe("formatComparison", () => {
	it("says there is nothing to compare when there is no baseline experiment", () => {
		expect(
			formatComparison({ previousExperiment: null, profiles: [] }),
		).toMatch(/no baseline experiment/);
	});

	it("prints precision, cost, seconds and the appeared/disappeared companies per profile", () => {
		const text = formatComparison({
			previousExperiment: "f67b7ae66ac5-baseline",
			profiles: [
				{
					profile: "mstone",
					precision: { current: 0.5, previous: 0.25, diff: 0.25 },
					costPerCompany: { current: 0.3, previous: 0.2, diff: 0.1 },
					secondsPerCompany: { current: 30, previous: 45, diff: -15 },
					appeared: ["americanitsolutions.com"],
					disappeared: ["valiify.com"],
				},
			],
		});
		expect(text).toContain("f67b7ae66ac5-baseline");
		expect(text).toContain("mstone:");
		expect(text).toContain("appeared: americanitsolutions.com");
		expect(text).toContain("disappeared: valiify.com");
	});
});
