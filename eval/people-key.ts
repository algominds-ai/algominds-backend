import { LabelSchema } from "@eval/label-core";
import { z } from "zod";

export const PersonKeyEntrySchema = z.object({
	label: LabelSchema,
	name: z.string().nullable(),
	title: z.string().nullable(),
	company: z.string(),
	location: z.string().nullable(),
	firstSeenRunId: z.string(),
	note: z.string().nullish(),
});

export type PersonKeyEntry = z.infer<typeof PersonKeyEntrySchema>;

export const PeopleKeyFileSchema = z.object({
	slug: z.string(),
	icpId: z.string(),
	people: z.record(z.string(), PersonKeyEntrySchema),
});

export type PeopleKeyFile = z.infer<typeof PeopleKeyFileSchema>;

export function emptyPeopleKeyFile(slug: string, icpId: string): PeopleKeyFile {
	return { slug, icpId, people: {} };
}

export type StoredPerson = {
	linkedinUrl: string;
	name: string | null;
	title: string | null;
	company: string;
	location: string | null;
	runId: string;
};

/**
 * `key` with one new unlabelled entry added per linkedin URL in `stored` the
 * key does not already carry. A label is never touched: the key only grows.
 */
export function mergeStoredPeople(
	key: PeopleKeyFile,
	stored: readonly StoredPerson[],
): PeopleKeyFile {
	const people = { ...key.people };
	for (const person of stored) {
		if (people[person.linkedinUrl]) continue;
		people[person.linkedinUrl] = {
			label: null,
			name: person.name,
			title: person.title,
			company: person.company,
			location: person.location,
			firstSeenRunId: person.runId,
		};
	}
	return { ...key, people };
}

export function unlabelledLinkedinUrls(key: PeopleKeyFile): string[] {
	return Object.entries(key.people)
		.filter(([, entry]) => entry.label === null)
		.map(([linkedinUrl]) => linkedinUrl)
		.sort();
}

export function sortedPeopleKeyFile(key: PeopleKeyFile): PeopleKeyFile {
	const people: PeopleKeyFile["people"] = {};
	for (const linkedinUrl of Object.keys(key.people).sort()) {
		const entry = key.people[linkedinUrl];
		if (entry) people[linkedinUrl] = entry;
	}
	return { ...key, people };
}
