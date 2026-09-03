import type { Candidate } from "@/core/people/candidate";
import { CandidateSchema } from "@/core/people/candidate";
import { canonicalPersonUrl } from "@/core/providers/clay";

const CREDENTIAL_TOKENS = new Set([
	"mba",
	"pmp",
	"cissp",
	"cpa",
	"phd",
	"mha",
	"cptm",
	"cfa",
	"jd",
	"md",
	"cism",
	"cisa",
	"ccie",
	"cpp",
	"shrm",
	"sphr",
	"phr",
]);

/** First|last name key with credential tokens and punctuation removed, so "Mary Hart, MHA" and "MHA Mary Hart" match. */
export function nameKey(name: string | null): string | null {
	const tokens = (name ?? "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.split(",")[0]
		?.replace(/[^a-z ]/g, " ")
		.split(/\s+/)
		.filter((word) => word && !CREDENTIAL_TOKENS.has(word) && word.length > 1);
	if (!tokens || tokens.length === 0) return null;
	return `${tokens[0]}|${tokens.at(-1)}`;
}

export type DedupeRow = Omit<Candidate, "id" | "seenBy"> & { source: string };

type MergedRow = Omit<Candidate, "id">;

type MergeContext = { existing: MergedRow; row: DedupeRow; url: string | null };

function preferredName(
	existing: string | null,
	incoming: string | null,
): string | null {
	if (!existing) return incoming;
	if (incoming && incoming.length > existing.length) return incoming;
	return existing;
}

function mergeInto({ existing, row, url }: MergeContext): void {
	if (!existing.seenBy.includes(row.source)) existing.seenBy.push(row.source);
	existing.title ??= row.title;
	existing.url ??= url;
	existing.company ??= row.company;
	existing.location ??= row.location;
	existing.since ??= row.since;
	existing.name = preferredName(existing.name, row.name);
}

function findExisting(
	byUrl: Map<string, MergedRow>,
	byName: Map<string, MergedRow>,
	url: string | null,
	key: string | null,
): MergedRow | undefined {
	const byUrlMatch = url ? byUrl.get(url) : undefined;
	if (byUrlMatch) return byUrlMatch;
	const byNameMatch = key ? byName.get(key) : undefined;
	if (!byNameMatch) return undefined;
	if (url && byNameMatch.url && byNameMatch.url !== url) return undefined;
	return byNameMatch;
}

function mergeRow(
	byUrl: Map<string, MergedRow>,
	byName: Map<string, MergedRow>,
	row: DedupeRow,
): void {
	const url = canonicalPersonUrl(row.url);
	const key = nameKey(row.name);
	const existing = findExisting(byUrl, byName, url, key);
	if (existing) {
		mergeInto({ existing, row, url });
		if (existing.url) byUrl.set(existing.url, existing);
		return;
	}
	const merged: MergedRow = {
		name: row.name,
		title: row.title,
		company: row.company,
		url,
		location: row.location,
		since: row.since,
		seenBy: [row.source],
	};
	if (url) byUrl.set(url, merged);
	if (key) byName.set(key, merged);
}

/** Merges candidate rows by canonical LinkedIn URL, then by name key, dropping every row with no name — a person with no name cannot be contacted or verified. A name hit whose stored row already carries a different canonical URL is a new candidate, never a merge. Records every source that saw each person and assigns ids by position in the merged list. */
export function dedupe(rows: DedupeRow[]): Candidate[] {
	const byUrl = new Map<string, MergedRow>();
	const byName = new Map<string, MergedRow>();
	for (const row of rows) {
		if (row.name !== null) mergeRow(byUrl, byName, row);
	}
	const unique = new Set<MergedRow>([...byUrl.values(), ...byName.values()]);
	return Array.from(unique).map((row, index) =>
		CandidateSchema.parse({ id: index, ...row }),
	);
}
