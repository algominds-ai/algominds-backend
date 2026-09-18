import { z } from "zod";

export const PeopleCompanySchema = z.object({
	domain: z.string(),
	name: z.string().nullable(),
	linkedinUrl: z.string().nullable(),
	exaId: z.string().nullable(),
	description: z.string().nullable(),
	workforceTotal: z.number().nullable(),
});
export type PeopleCompany = z.infer<typeof PeopleCompanySchema>;
