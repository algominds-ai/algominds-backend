import { describe, expect, it } from "vitest";
import { RATES } from "@/core/rates";

describe("RATES", () => {
	it("prices Findymail's search credits and verifier credits as two separate pools", () => {
		expect(RATES.findymail?.credits).toBe(0.01);
		expect(RATES.findymail?.verifier_credits).toBe(0.01);
	});

	it("has no rate for a provider or unit it does not price", () => {
		expect(RATES.findymail?.records).toBeUndefined();
		expect(RATES.unknownVendor).toBeUndefined();
	});
});
