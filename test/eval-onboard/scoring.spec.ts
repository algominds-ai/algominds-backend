import type { IcpDoc } from "@eval/icp-doc";
import type { WrittenOnboardProfile } from "@eval/onboard-score";
import { scoreOnboardProfile } from "@eval/onboard-score";
import { describe, expect, it } from "vitest";

const fixture: IcpDoc = {
	description: "test",
	buyer: {
		rubric: "The buyer is the CRO or the Head of Growth.",
		bands: [],
		keywordBands: [],
	},
	requirements: [
		{
			id: "r1",
			kind: "hard",
			proof: "record",
			windowDays: null,
			text: "The company is privately held with $2M to $250M in funding.",
		},
		{
			id: "r2",
			kind: "hard",
			proof: "record",
			windowDays: null,
			text: "The company runs high-volume consumer signup in fintech.",
		},
	],
};

function buildWritten(
	overrides: Partial<WrittenOnboardProfile> = {},
): WrittenOnboardProfile {
	return {
		description: "A short profile under a thousand characters naming who buys.",
		buyer: { rubric: "The buyer is the CRO or the Head of Growth." },
		requirements: [
			{
				id: "w1",
				kind: "hard",
				proof: "record",
				windowDays: null,
				text: "The company is privately held with $2M to $250M in funding.",
			},
			{
				id: "w2",
				kind: "hard",
				proof: "record",
				windowDays: null,
				text: "The company runs high-volume consumer signup in fintech.",
			},
		],
		...overrides,
	};
}

describe("scoreOnboardProfile", () => {
	it("passes every check for a document matching the fixture", () => {
		const checks = scoreOnboardProfile(buildWritten(), fixture);
		const failed = checks.filter((check) => !check.passed);
		expect(failed).toEqual([]);
		expect(checks.length).toBeGreaterThan(0);
	});

	it("fails the banned-word check and a bound check when a hard requirement carries a bonus-only word and drops the upper bound", () => {
		const written = buildWritten({
			requirements: [
				{
					id: "w1",
					kind: "hard",
					proof: "page",
					windowDays: null,
					text: "The company recently launched with more than $2M in funding.",
				},
				{
					id: "w2",
					kind: "hard",
					proof: "record",
					windowDays: null,
					text: "The company runs high-volume consumer signup in fintech.",
				},
			],
		});
		const checks = scoreOnboardProfile(written, fixture);
		const byName = new Map(checks.map((check) => [check.name, check.passed]));
		expect(
			byName.get("no written hard requirement carries a bonus-only word"),
		).toBe(false);
		expect(
			byName.get("numeric bound 250M appears in a written hard requirement"),
		).toBe(false);
		expect(
			byName.get("numeric bound 2M appears in a written hard requirement"),
		).toBe(true);
	});
});
