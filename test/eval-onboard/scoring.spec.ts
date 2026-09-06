import type { IcpDoc } from "@eval/icp-doc";
import { scoreOnboardProfile } from "@eval/onboard-score";
import { describe, expect, it } from "vitest";

const fixture: IcpDoc = {
	version: 1,
	extracted: true,
	instructions: "Sell analytics to product leaders.",
	seller: {
		domain: "seller.example",
		description: "Analytics",
		customers: [],
		sourceUrls: ["https://seller.example"],
	},
	icp: {
		offer: "Analytics",
		buyer: "Product leaders",
		requirements: [],
		unknowns: [],
	},
};

describe("scoreOnboardProfile", () => {
	it("checks canonical structure and preserved source input", () => {
		expect(
			scoreOnboardProfile(fixture, fixture).every((check) => check.passed),
		).toBe(true);
	});

	it("does not impose semantic regex rules or lossy size limits", () => {
		const written = {
			...fixture,
			instructions: "A long but exact targeting note",
		};
		const checks = scoreOnboardProfile(written, fixture);
		expect(
			checks.find(
				(check) => check.name === "profile matches canonical onboarding schema",
			)?.passed,
		).toBe(true);
		expect(
			checks.find(
				(check) => check.name === "targeting instructions are preserved",
			)?.passed,
		).toBe(false);
	});
});
