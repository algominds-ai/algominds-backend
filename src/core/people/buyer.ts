import { z } from "zod";
import type { IcpDoc } from "@/core/synthesize";
import { BandSchema, IcpBuyerSchema, SENIOR_BANDS } from "@/core/synthesize";

export const ResolvedBuyerSchema = z.object({
	mode: z.enum(["target", "profile", "roster"]),
	buyerSource: z.enum(["target", "captured", "description", "none"]),
	rubric: z.string().nullable(),
	bands: z.array(BandSchema),
	keywordBands: IcpBuyerSchema.shape.keywordBands,
});

export type ResolvedBuyer = z.infer<typeof ResolvedBuyerSchema>;

export type ResolveBuyerInput = {
	target: string | string[] | null;
	profile: IcpDoc | null;
};

function targetRubric(target: string | readonly string[]): string {
	if (typeof target === "string") return target;
	return ["Titles to find:", ...target.map((title) => `- ${title}`)].join("\n");
}

/**
 * Resolves who the buyer is by walking the ladder: request target, then
 * captured profile buyer, then profile description, then roster mode. Returns
 * the plain, storable rung that answered.
 */
export function resolveBuyer(input: ResolveBuyerInput): ResolvedBuyer {
	const { target, profile } = input;

	if (target !== null) {
		return {
			mode: "target",
			buyerSource: "target",
			rubric: targetRubric(target),
			bands: [...SENIOR_BANDS],
			keywordBands: [],
		};
	}

	if (profile?.buyer) {
		return {
			mode: "profile",
			buyerSource: "captured",
			rubric: profile.buyer.rubric,
			bands: profile.buyer.bands,
			keywordBands: profile.buyer.keywordBands,
		};
	}

	if (profile) {
		return {
			mode: "profile",
			buyerSource: "description",
			rubric: profile.description,
			bands: [...SENIOR_BANDS],
			keywordBands: [],
		};
	}

	return {
		mode: "roster",
		buyerSource: "none",
		rubric: null,
		bands: [...SENIOR_BANDS],
		keywordBands: [],
	};
}
