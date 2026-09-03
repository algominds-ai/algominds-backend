import { z } from "zod";
import type { NewEvidence, NewPerson } from "@/core/db/schema";
import type { Candidate } from "@/core/people/candidate";

export const PersonStatusSchema = z.enum(["verified", "roster"]);
export type PersonStatus = z.infer<typeof PersonStatusSchema>;

export const PersonDataSchema = z.object({
	status: PersonStatusSchema,
	basis: z.string().nullable(),
	seenBy: z.array(z.string()),
	since: z.string().nullable(),
	location: z.string().nullable(),
});
export type PersonData = z.infer<typeof PersonDataSchema>;

export type NewPersonLink = {
	companyId: string;
	organizationId: string;
};

/** One deduped candidate as a storable person row, or null when it carries no LinkedIn URL to key it on. */
export function toNewPerson(
	candidate: Candidate,
	link: NewPersonLink,
	status: PersonStatus,
	basis: string | null,
): NewPerson | null {
	if (!candidate.url) return null;
	return {
		organizationId: link.organizationId,
		companyId: link.companyId,
		linkedinUrl: candidate.url,
		name: candidate.name,
		title: candidate.title,
		data: PersonDataSchema.parse({
			status,
			basis,
			seenBy: candidate.seenBy,
			since: candidate.since,
			location: candidate.location,
		}),
	};
}

function evidenceValue(body: unknown): string {
	if (body === null) return "null";
	return typeof body === "string" ? body : JSON.stringify(body);
}

/** One append-only evidence row for a raw provider or model reply, kept on the run's per-domain row unshaped. */
export function rawEvidenceRow(
	runCompanyId: string,
	kind: string,
	source: string,
	body: unknown,
): NewEvidence {
	return {
		subjectType: "run_company",
		subjectId: runCompanyId,
		kind,
		source,
		value: evidenceValue(body),
	};
}

export type PersonVerifyEvidence = {
	personId: string;
	runCompanyId: string;
	kind: string;
	source: string;
	body: unknown;
};

/** One append-only evidence row for a verification reply about the person it judged, with the run_company it was judged under kept inside the value. */
export function personVerifyEvidenceRow(
	input: PersonVerifyEvidence,
): NewEvidence {
	return {
		subjectType: "person",
		subjectId: input.personId,
		kind: input.kind,
		source: input.source,
		value: evidenceValue({
			runCompanyId: input.runCompanyId,
			body: input.body,
		}),
	};
}
