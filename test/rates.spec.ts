import { describe, expect, it } from "vitest";
import { RATES } from "../src/core/rates";

describe("RATES", () => {
	it("prices Findymail by credits", () => {
		expect(RATES.findymail?.credits).toBe(0.01);
	});

	it("has no rate for a provider or unit it does not price", () => {
		expect(RATES.findymail?.records).toBeUndefined();
		expect(RATES.unknownVendor).toBeUndefined();
	});
});
