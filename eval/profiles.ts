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
 * The six profiles the eval engine measures against: four already onboarded
 * in the shared dev database, and two shape profiles (dental, hvac) whose
 * `icpId` is a fixed id minted for this eval only — `eval/arm-seed.ts`
 * seeds it into every isolated arm database with a hand-written profile
 * document, so no onboarding call, and no vendor spend, is needed to give
 * them a stable identity. Each profile's hard page requirements, if it has
 * any, come from its own `icp.doc.requirements` at read time rather than
 * being repeated here.
 */
export const PROFILES: readonly Profile[] = [
	{
		slug: "mstone",
		icpId: "15ac4f10-20f3-4970-967e-a1882a57f28f",
		name: "Mstone Group",
		keyVar: "EVAL_API_KEY_MSTONE",
		bars: { maxCostDollars: 1, maxSeconds: 120 },
		countries: ["Australia"],
	},
	{
		slug: "aris",
		icpId: "5e8ca999-8a24-442a-853b-23c11bfd5d05",
		name: "Aris",
		keyVar: "EVAL_API_KEY_ARIS",
		bars: { maxCostDollars: 1, maxSeconds: 120 },
		countries: ["United States"],
	},
	{
		slug: "form3",
		icpId: "cf9f5feb-bdb7-43ab-8899-09f1e1fa468b",
		name: "Form3 Trust Fabric",
		keyVar: "EVAL_API_KEY_FORM3",
		bars: { maxCostDollars: 2, maxSeconds: 180 },
		countries: [
			"United Kingdom",
			"Ireland",
			"United States",
			"Canada",
			"Germany",
			"France",
			"Netherlands",
			"Spain",
			"Sweden",
			"Denmark",
			"Norway",
			"Finland",
			"Belgium",
			"Switzerland",
			"Austria",
			"Italy",
			"Poland",
			"Portugal",
			"Luxembourg",
		],
	},
	{
		slug: "carta",
		icpId: "052615e9-c25b-430c-bade-a65877431b4e",
		name: "Carta",
		keyVar: "EVAL_API_KEY_CARTA",
		bars: { maxCostDollars: 1.5, maxSeconds: 150 },
		countries: [
			"United States",
			"Canada",
			"United Kingdom",
			"Germany",
			"France",
			"Netherlands",
			"Spain",
			"Sweden",
			"Denmark",
			"Ireland",
		],
	},
	{
		slug: "ondato",
		icpId: "18c490ee-009d-44b8-afd3-e0103f5a1ae7",
		name: "Ondato",
		keyVar: "EVAL_API_KEY_ONDATO",
		bars: { maxCostDollars: 2, maxSeconds: 240 },
		countries: ["United Kingdom", "Ireland", "United States", "Canada"],
	},
	{
		slug: "dental",
		icpId: "4213915c-0b0c-43f0-bd4a-5379e3a0a594",
		name: "Dental practice management (mid-market vertical SaaS shape)",
		keyVar: "EVAL_API_KEY_DENTAL",
		bars: { maxCostDollars: 1.5, maxSeconds: 150 },
		countries: ["United States"],
	},
	{
		slug: "hvac",
		icpId: "bad48334-f775-4e9a-9032-9d51a16f2f1d",
		name: "Commercial HVAC contractors (local services shape)",
		keyVar: "EVAL_API_KEY_HVAC",
		bars: { maxCostDollars: 1.5, maxSeconds: 150 },
		countries: ["United States"],
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
