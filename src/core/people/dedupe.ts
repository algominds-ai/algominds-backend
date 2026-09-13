import type { Candidate } from "@/core/people/candidate";
import { canonicalPersonUrl } from "@/core/providers/clay";

export type DedupeRow = Omit<Candidate, "id" | "seenBy"> & { source: string };

function mergeRoles(previous: Candidate, row: DedupeRow): void {
	previous.seenBy = [...new Set([...previous.seenBy, row.source])];
	previous.title =
		[...new Set([previous.title, row.title].filter(Boolean))].join("; ") ||
		null;
}

/** Unions canonical profiles without merging namesakes or unproven URL aliases. */
export function dedupe(rows: readonly DedupeRow[]): Candidate[] {
	const profiles = new Map<string, Candidate>();
	const unnamed: Candidate[] = [];
	for (const row of rows) {
		if (!row.name?.trim()) continue;
		const url = canonicalPersonUrl(row.url);
		const previous = url ? profiles.get(url) : undefined;
		if (previous) {
			mergeRoles(previous, row);
			continue;
		}
		const { source, ...person } = row;
		const candidate = { ...person, url, id: 0, seenBy: [source] };
		if (url) profiles.set(url, candidate);
		else unnamed.push(candidate);
	}
	return [...profiles.values(), ...unnamed].map((candidate, id) => ({
		...candidate,
		id,
	}));
}
