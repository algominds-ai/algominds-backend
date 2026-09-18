import { z } from "zod";

export const WindowSchema = z.object({
	amount: z.number().int().positive(),
	unit: z.enum(["days", "months", "years"]),
	appliesTo: z.enum(["event", "publication", "observation"]),
	direction: z.enum(["past", "future"]),
});

export const ConditionSchema = z.object({
	text: z.string().min(1),
	window: WindowSchema.nullable(),
	sourceRule: z.string().nullable(),
});

export const RequirementSchema = z.object({
	kind: z.enum(["required", "preferred"]),
	anyOf: z.array(z.object({ allOf: z.array(ConditionSchema).min(1) })).min(1),
});

export const AccountProfileSchema = z.object({
	seller: z.object({
		domain: z.string().min(1).nullable(),
		description: z.string(),
		customers: z.array(z.string()),
		sourceUrls: z.array(z.string()),
	}),
	icp: z.object({
		offer: z.string().nullable(),
		buyer: z.string().nullable(),
		requirements: z.array(RequirementSchema),
		unknowns: z.array(z.string()),
	}),
});

export const IcpDocSchema = AccountProfileSchema.extend({
	version: z.literal(1),
	extracted: z.boolean(),
	instructions: z.string().nullable(),
});

export type Condition = z.infer<typeof ConditionSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type AccountProfile = z.infer<typeof AccountProfileSchema>;
export type IcpDoc = z.infer<typeof IcpDocSchema>;
export type IcpSeller = IcpDoc["seller"];

/** A saved request awaiting extraction, with its exact instructions retained as the source. */
export function draftIcp(
	domain: string | null,
	instructions: string | null,
): IcpDoc {
	return {
		version: 1,
		extracted: false,
		instructions,
		seller: { domain, description: "", customers: [], sourceUrls: [] },
		icp: { offer: null, buyer: null, requirements: [], unknowns: [] },
	};
}
