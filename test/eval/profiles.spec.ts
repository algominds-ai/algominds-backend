import { PROFILES, stageCeilingSeconds } from "@eval/profiles";
import { describe, expect, it } from "vitest";

function profile(slug: string) {
	const found = PROFILES.find((candidate) => candidate.slug === slug);
	if (!found) throw new Error(`test setup: unknown profile ${slug}`);
	return found;
}

describe("stageCeilingSeconds", () => {
	it("doubles the profile's full-chain seconds bar", () => {
		expect(stageCeilingSeconds(profile("mstone"))).toBe(800);
	});

	it("scales with a heavier profile's own full-chain bar", () => {
		expect(stageCeilingSeconds(profile("ondato"))).toBe(1600);
	});
});
