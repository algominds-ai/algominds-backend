import { ARM_SEED_PROFILES } from "@eval/arm-seed";
import { PROFILES } from "@eval/profiles";
import { describe, expect, it } from "vitest";

describe("ARM_SEED_PROFILES", () => {
	it("carries one parsed profile document per profile, in the same order", () => {
		expect(ARM_SEED_PROFILES.map((profile) => profile.slug)).toEqual(
			PROFILES.map((profile) => profile.slug),
		);
	});

	it("carries the profile's own icpId and a non-empty description", () => {
		for (const [index, profile] of ARM_SEED_PROFILES.entries()) {
			expect(profile.icpId).toBe(PROFILES[index]?.icpId);
			expect(profile.doc.description.length).toBeGreaterThan(0);
		}
	});
});
