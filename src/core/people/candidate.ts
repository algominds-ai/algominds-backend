import { z } from "zod";

export const CandidateSchema = z.object({
	id: z.number().int().nonnegative(),
	name: z.string().nullable(),
	title: z.string().nullable(),
	company: z.string().nullable(),
	url: z.string().nullable(),
	location: z.string().nullable(),
	since: z.string().nullable(),
	seenBy: z.array(z.string()),
});

export type Candidate = z.infer<typeof CandidateSchema>;
