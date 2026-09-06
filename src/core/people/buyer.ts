import { z } from "zod";
import type { IcpDoc } from "@/core/icp";

export const ResolvedBuyerSchema = z.object({
	mode: z.enum(["target", "profile", "roster"]),
	buyerSource: z.enum(["target", "captured", "none"]),
	offer: z.string().nullable(),
	instructions: z.string().nullable(),
	rubric: z.string().nullable(),
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

function context(
	profile: IcpDoc | null,
): Pick<ResolvedBuyer, "offer" | "instructions"> {
	return {
		offer: profile?.icp.offer ?? null,
		instructions: profile?.instructions ?? null,
	};
}

/**
 * Resolves the explicit request target before the canonical ICP buyer string.
 * A profile without a buyer stays roster-only; seller description is never a
 * person-selection rubric.
 */
export function resolveBuyer(input: ResolveBuyerInput): ResolvedBuyer {
	const { target, profile } = input;
	const shared = context(profile);

	if (target !== null) {
		return {
			mode: "target",
			buyerSource: "target",
			rubric: targetRubric(target),
			...shared,
		};
	}

	if (profile?.icp.buyer) {
		return {
			mode: "profile",
			buyerSource: "captured",
			rubric: profile.icp.buyer,
			...shared,
		};
	}

	return {
		mode: "roster",
		buyerSource: "none",
		rubric: null,
		...shared,
	};
}
