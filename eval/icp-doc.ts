import { z } from "zod";
import { RequirementSchema } from "@/core/requirements";

/**
 * The profile document shape stored in `icp.doc`, redeclared here rather
 * than imported from `@/core/synthesize`: that module reaches
 * `@/core/providers/clay` for its buyer-band enum, which imports
 * `cloudflare:workflows` and cannot load under plain Bun. `bands` is a
 * loose string here rather than the vendor's closed enum — the eval only
 * needs to know a seed document parses, not to enforce the enum a live
 * onboarding call already enforced when it wrote the real profile.
 */
export const IcpDocSchema = z.object({
	description: z.string(),
	seller: z
		.object({
			domain: z.string(),
			customers: z.array(z.string()),
			competitorTest: z.string(),
		})
		.nullish(),
	buyer: z
		.object({
			rubric: z.string(),
			bands: z.array(z.string()),
			keywordBands: z.array(
				z.object({ band: z.string(), keywords: z.array(z.string()) }),
			),
		})
		.nullish(),
	requirements: z.array(RequirementSchema).nullish(),
});

export type IcpDoc = z.infer<typeof IcpDocSchema>;
