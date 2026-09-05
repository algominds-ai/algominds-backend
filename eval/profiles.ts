import { z } from "zod";

export const BRAINTRUST_PROJECT = "algo-backend";
export const MAX_SPEND_DOLLARS = 8;
export const MAX_PROFILE_SPEND_DOLLARS = 2;
export const MIN_TRIALS = 2;
export const COMPANIES_PER_RUN = 3;

/**
 * A run over one profile stops meaning anything past these bars: a
 * companies run over budget or over time did not answer the question the
 * eval asks. Set with headroom above the highest cost measured on the runs
 * already stored (`docs/solutions/eval.md`); recalibrate once the
 * coordinator authorizes the first paid arm.
 */
export const ProfileBarsSchema = z.object({
	maxCostDollars: z.number().positive(),
	maxSeconds: z.number().positive(),
});

export type ProfileBars = z.infer<typeof ProfileBarsSchema>;

export const ProfileSchema = z.object({
	slug: z.string(),
	icpId: z.string(),
	name: z.string(),
	keyVar: z.string(),
	bars: ProfileBarsSchema,
	countries: z.array(z.string()),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * The profile the onboarding eval measures against on this branch: the one
 * whose corrected profile document ships as its arm-seed fixture. Each
 * profile's hard page requirements, if it has any, come from its own
 * `icp.doc.requirements` at read time rather than being repeated here.
 */
export const PROFILES: readonly Profile[] = [
	{
		slug: "ondato",
		icpId: "18c490ee-009d-44b8-afd3-e0103f5a1ae7",
		name: "Ondato",
		keyVar: "EVAL_API_KEY_ONDATO",
		bars: { maxCostDollars: 2, maxSeconds: 240 },
		countries: ["United Kingdom", "Ireland", "United States", "Canada"],
	},
] as const;

export function profileBySlug(slug: string): Profile | undefined {
	return PROFILES.find((profile) => profile.slug === slug);
}

/** Every profile when `slug` is null, or the one profile it names; throws for a slug no profile carries. */
export function profilesFor(slug: string | null): readonly Profile[] {
	if (!slug) return PROFILES;
	const profile = profileBySlug(slug);
	if (!profile) throw new Error(`eval: unknown profile ${slug}`);
	return [profile];
}
