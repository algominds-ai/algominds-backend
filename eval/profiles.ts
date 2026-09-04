import { z } from "zod";

export const BRAINTRUST_PROJECT = "algo-backend";

export const ProfileSchema = z.object({
	slug: z.string(),
	icpId: z.string().nullable(),
	name: z.string(),
	keyVar: z.string(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * The six profiles the eval engine measures against: four onboarded
 * accounts and two shape profiles pending onboarding (`icpId: null`) until
 * the coordinator authorizes the vendor spend an onboarding call carries.
 */
export const PROFILES: readonly Profile[] = [
	{
		slug: "mstone",
		icpId: "15ac4f10-20f3-4970-967e-a1882a57f28f",
		name: "Mstone Group",
		keyVar: "EVAL_API_KEY_MSTONE",
	},
	{
		slug: "aris",
		icpId: "5e8ca999-8a24-442a-853b-23c11bfd5d05",
		name: "Aris",
		keyVar: "EVAL_API_KEY_ARIS",
	},
	{
		slug: "form3",
		icpId: "cf9f5feb-bdb7-43ab-8899-09f1e1fa468b",
		name: "Form3 Trust Fabric",
		keyVar: "EVAL_API_KEY_FORM3",
	},
	{
		slug: "carta",
		icpId: "052615e9-c25b-430c-bade-a65877431b4e",
		name: "Carta",
		keyVar: "EVAL_API_KEY_CARTA",
	},
	{
		slug: "dental",
		icpId: null,
		name: "Dental practice management (mid-market vertical SaaS shape)",
		keyVar: "EVAL_API_KEY_DENTAL",
	},
	{
		slug: "hvac",
		icpId: null,
		name: "Commercial HVAC contractors (local services shape)",
		keyVar: "EVAL_API_KEY_HVAC",
	},
] as const;

export function profileBySlug(slug: string): Profile | undefined {
	return PROFILES.find((profile) => profile.slug === slug);
}
