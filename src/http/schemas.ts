import { z } from "zod";
import { config } from "@/config";
import { normalizeDomain } from "@/core/db/schema";

export const icpRef = z.union([
	z.object({ icpId: z.uuid() }),
	z.object({ prompt: z.string().min(1) }),
]);

export const companiesFindSchema = z.intersection(
	icpRef,
	z.object({
		count: z
			.number()
			.int()
			.positive()
			.max(config.limits.maxCompaniesPerRequest),
	}),
);

export function normalizedDomainList(
	values: string[],
	ctx: z.RefinementCtx,
): string[] {
	const normalized = values.map((value) => {
		try {
			return normalizeDomain(value);
		} catch {
			ctx.addIssue({ code: "custom", message: `not a valid domain: ${value}` });
			return value;
		}
	});
	return [...new Set(normalized)].sort();
}

export const domainsField = z
	.array(z.string().min(1))
	.min(1)
	.max(config.limits.maxCompaniesPerPeopleRun)
	.transform(normalizedDomainList);

export const maxCompaniesField = z.number().int().positive().optional();

export const peopleFindSchema = z.union([
	z.strictObject({ runId: z.string().min(1), maxCompanies: maxCompaniesField }),
	z.strictObject({ domains: domainsField, maxCompanies: maxCompaniesField }),
]);

export const enrichSchema = z.strictObject({
	runId: z.string().min(1),
	channels: z.array(z.enum(["email", "linkedin"])).min(1),
});

export const pageQuerySchema = z.object({
	limit: z.coerce.number().int().positive().optional(),
	cursor: z.uuid().optional(),
});
