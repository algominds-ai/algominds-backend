import { z } from "zod";
import { publicDomain } from "@/core/db/schema";
import { IcpDocSchema } from "@/core/icp";

export const SuiteSchema = z.enum(["onboarding", "company", "people"]);
export type Suite = z.infer<typeof SuiteSchema>;
const DomainSchema = z
	.string()
	.refine((value) => publicDomain(value) === value);
const BaseInput = z.object({
	slug: z.string().regex(/^[a-z0-9-]+$/),
	stage: z
		.enum([
			"engine",
			"extraction",
			"synthesis",
			"judging",
			"prefilter",
			"verification",
		])
		.default("engine"),
	sample: z.json().nullable().default(null),
});
export const OnboardingInputSchema = BaseInput.extend({
	suite: z.literal("onboarding"),
	domain: DomainSchema,
	note: z.string().nullable(),
});
export const CompanyInputSchema = BaseInput.extend({
	suite: z.literal("company"),
	profile: IcpDocSchema,
	count: z.number().int().min(1).max(20),
});
export const PeopleInputSchema = BaseInput.extend({
	suite: z.literal("people"),
	profile: IcpDocSchema,
	domains: z
		.array(DomainSchema)
		.min(1)
		.max(20)
		.refine((values) => new Set(values).size === values.length),
});
export const InputSchema = z.discriminatedUnion("suite", [
	OnboardingInputSchema,
	CompanyInputSchema,
	PeopleInputSchema,
]);
export type Input = z.infer<typeof InputSchema>;

export const ReferenceSchema = z.object({
	id: z.string().min(1),
	company: z.string().nullable(),
	judgment: z.enum(["accept", "reject", "unresolved"]),
	rationale: z.string().min(1),
	sources: z.array(z.url()).min(1),
	reviewedAt: z.iso.datetime(),
});
export const ExpectedSchema = z.object({
	rubric: z.string().min(1),
	references: z.array(ReferenceSchema),
	closedWorld: z.boolean().default(false),
	sources: z.array(z.object({ url: z.url(), text: z.string() })).default([]),
});
export type Expected = z.infer<typeof ExpectedSchema>;
export const CaseSchema = z.object({
	id: z.string().min(1),
	input: InputSchema,
	expected: ExpectedSchema,
});

export const EntitySchema = z.object({
	id: z.string(),
	company: z.string().nullable(),
	name: z.string().nullable(),
	title: z.string().nullable(),
	data: z.json().nullable(),
});
export const EvidenceSchema = z.object({
	subject: z.string(),
	kind: z.string(),
	value: z.string(),
	source: z.string(),
	seenAt: z.string(),
});
export const OutputSchema = z.object({
	component: z.json().nullable().default(null),
	runId: z.string().nullable(),
	status: z.string(),
	error: z.string().nullable(),
	asOf: z.iso.datetime(),
	costDollars: z.number().nonnegative().nullable(),
	seconds: z.number().nonnegative().nullable(),
	profile: IcpDocSchema.nullable(),
	verificationCostDollars: z.number().nonnegative().nullable().default(null),
	entities: z.array(EntitySchema),
	evidence: z.array(EvidenceSchema),
	diagnostics: z.array(z.json()),
});
export type Output = z.infer<typeof OutputSchema>;

export function failedOutput(error: string): Output {
	return {
		component: null,
		runId: null,
		status: "errored",
		error,
		asOf: new Date().toISOString(),
		costDollars: null,
		seconds: null,
		verificationCostDollars: null,
		profile: null,
		entities: [],
		evidence: [],
		diagnostics: [],
	};
}
