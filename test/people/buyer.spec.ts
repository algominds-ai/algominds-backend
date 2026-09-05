import { describe, expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import type { IcpDoc } from "@/core/synthesize";
import { SENIOR_BANDS } from "@/core/synthesize";

const capturedProfile: IcpDoc = {
	description: "fintech companies at seed stage in San Francisco",
	buyer: {
		rubric: "The head of finance or the founder who owns the budget.",
		bands: ["founder", "c-suite"],
		keywordBands: [{ band: "manager", keywords: ["finance", "budget"] }],
	},
};

const descriptionOnlyProfile: IcpDoc = {
	description: "fintech companies at seed stage in San Francisco",
};

describe("resolveBuyer: request target rung", () => {
	it("uses a request target without consulting the profile buyer", () => {
		const resolved = resolveBuyer({
			target: ["VP Product", "Head of Growth"],
			profile: capturedProfile,
		});

		expect(resolved).toEqual({
			mode: "target",
			buyerSource: "target",
			rubric: "Titles to find:\n- VP Product\n- Head of Growth",
			bands: SENIOR_BANDS,
			keywordBands: [],
		});
	});

	it("uses a single target sentence verbatim as the rubric", () => {
		const resolved = resolveBuyer({
			target: "the marketing team",
			profile: capturedProfile,
		});

		expect(resolved).toEqual({
			mode: "target",
			buyerSource: "target",
			rubric: "the marketing team",
			bands: SENIOR_BANDS,
			keywordBands: [],
		});
	});
});

describe("resolveBuyer: captured buyer rung", () => {
	it("uses the captured buyer before the profile description", () => {
		const resolved = resolveBuyer({ target: null, profile: capturedProfile });

		expect(resolved).toEqual({
			mode: "profile",
			buyerSource: "captured",
			rubric: capturedProfile.buyer?.rubric,
			bands: capturedProfile.buyer?.bands,
			keywordBands: capturedProfile.buyer?.keywordBands,
		});
	});
});

describe("resolveBuyer: profile description rung", () => {
	it("falls through to the profile description when no buyer was captured", () => {
		const resolved = resolveBuyer({
			target: null,
			profile: descriptionOnlyProfile,
		});

		expect(resolved).toEqual({
			mode: "profile",
			buyerSource: "description",
			rubric: descriptionOnlyProfile.description,
			bands: SENIOR_BANDS,
			keywordBands: [],
		});
	});
});

describe("resolveBuyer: roster rung", () => {
	it("falls through to roster mode without buyer context", () => {
		const resolved = resolveBuyer({ target: null, profile: null });

		expect(resolved).toEqual({
			mode: "roster",
			buyerSource: "none",
			rubric: null,
			bands: SENIOR_BANDS,
			keywordBands: [],
		});
	});
});
