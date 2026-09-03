import { z } from "zod";
import { config } from "@/config";
import { normalizeDomain, publicDomain } from "@/core/db/schema";
import { NOTE_MAX_LENGTH, NOTE_MIN_LENGTH } from "@/core/onboard";

export const icpRef = z.union([
	z.object({ icpId: z.uuid() }),
	z.object({ prompt: z.string().min(1) }),
]);

export function normalizedDomainValue(
	value: string,
	ctx: z.RefinementCtx,
): string {
	try {
		return normalizeDomain(value);
	} catch {
		ctx.addIssue({ code: "custom", message: `not a valid domain: ${value}` });
		return value;
	}
}

export function normalizedDomainList(
	values: string[],
	ctx: z.RefinementCtx,
): string[] {
	const normalized = values.map((value) => normalizedDomainValue(value, ctx));
	return [...new Set(normalized)].sort();
}

export const domainsField = z
	.array(z.string().min(1))
	.min(1)
	.max(config.limits.maxCompaniesPerPeopleRun)
	.transform(normalizedDomainList);

/** A domain the engine can crawl. Refused at the boundary rather than by the run it would otherwise start. */
export const domainField = z
	.string()
	.min(1)
	.transform((value, ctx) => {
		const host = publicDomain(value);
		if (host === null) {
			ctx.addIssue({
				code: "custom",
				message: `not a public domain: ${value}`,
			});
			return value;
		}
		return host;
	});

export const companiesFindSchema = z.intersection(
	icpRef,
	z.object({
		count: z
			.number()
			.int()
			.positive()
			.max(config.limits.maxCompaniesPerRequest),
		excludeDomains: domainsField.optional(),
	}),
);

export const maxCompaniesField = z.number().int().positive().optional();

/** Who a find-people request says to find: a bounded title list, or one sentence. */
export const targetField = z.union([
	z.array(z.string().trim().min(2).max(80)).min(1).max(20),
	z.string().trim().min(3).max(300),
]);

export const peopleFindSchema = z.union([
	z.strictObject({
		runId: z.string().min(1),
		maxCompanies: maxCompaniesField,
		target: targetField.optional(),
	}),
	z.strictObject({
		domains: domainsField,
		maxCompanies: maxCompaniesField,
		target: targetField.optional(),
		icpId: z.uuid().optional(),
	}),
]);

export const enrichSchema = z.strictObject({
	runId: z.string().min(1),
	channels: z.array(z.enum(["email", "linkedin"])).min(1),
});

export const onboardIcpSchema = z.strictObject({
	domain: domainField,
	note: z.string().min(NOTE_MIN_LENGTH).max(NOTE_MAX_LENGTH).optional(),
});

export const pageQuerySchema = z.object({
	limit: z.coerce.number().int().positive().optional(),
	cursor: z.uuid().optional(),
});
