import {
	ARM_SEED_PROFILES,
	UNSUPPORTED_LEGACY_ARM_SEEDS,
} from "@eval/arm-seed";
import { PROFILES } from "@eval/profiles";
import { describe, expect, it } from "vitest";

describe("legacy arm seeds", () => {
	it("runs only recorded canonical profiles and marks legacy inputs", () => {
		expect(ARM_SEED_PROFILES.map((profile) => profile.slug)).toEqual([
			"aris",
			"form3",
			"ondato",
		]);
		expect(UNSUPPORTED_LEGACY_ARM_SEEDS).toEqual(
			PROFILES.map((profile) => profile.slug),
		);
	});
});
