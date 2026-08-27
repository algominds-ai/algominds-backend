import { describe, expect, it } from "vitest";
import { EXA_EFFORT_DOLLARS, RATES } from "../src/core/rates";

describe("RATES", () => {
	it("prices Apollo by credits and BrightData by records", () => {
		expect(RATES.apollo?.credits).toBe(0.01);
		expect(RATES.brightdata?.records).toBe(0.0025);
	});

	it("has no rate for a provider or unit it does not price", () => {
		expect(RATES.apollo?.records).toBeUndefined();
		expect(RATES.unknownVendor).toBeUndefined();
	});
});

describe("EXA_EFFORT_DOLLARS", () => {
	it("prices every Exa effort tier", () => {
		expect(EXA_EFFORT_DOLLARS).toEqual({
			minimal: 0.012,
			low: 0.025,
			medium: 0.1,
			high: 0.5,
			xhigh: 1,
		});
	});
});
