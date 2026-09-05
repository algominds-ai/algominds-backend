import type { Candidate } from "@/core/people/candidate";
import { canonicalPersonUrl } from "@/core/providers/clay";

const CREDENTIAL_SUFFIX = /,\s*[a-z.]{2,6}$/;

function normalizedFullName(name: string | null): string | null {
	if (!name) return null;
	const collapsed = name.trim().replace(/\s+/g, " ").toLowerCase();
	const stripped = collapsed.replace(CREDENTIAL_SUFFIX, "").trim();
	return stripped || null;
}

function normalizedTitle(title: string | null): string | null {
	if (!title) return null;
	const collapsed = title.trim().replace(/\s+/g, " ").toLowerCase();
	return collapsed || null;
}

export type CandidateIdentity = Pick<Candidate, "name" | "title" | "url">;

export type PersonIdentityKeys = {
	url: string | null;
	nameTitle: string | null;
};

/** The canonical LinkedIn URL and the normalized name, title and domain key that together identify one person within a company. Either key alone is enough for two candidates to name the same person. */
export function personIdentityKeys(
	candidate: CandidateIdentity,
	domain: string,
): PersonIdentityKeys {
	const url = canonicalPersonUrl(candidate.url);
	const name = normalizedFullName(candidate.name);
	const title = normalizedTitle(candidate.title);
	return {
		url,
		nameTitle: name && title ? `${name}|${title}|${domain}` : null,
	};
}

export type IdentityGroup<T> = { canonical: T; duplicates: T[] };

function existingGroup<T>(
	byUrl: Map<string, IdentityGroup<T>>,
	byNameTitle: Map<string, IdentityGroup<T>>,
	keys: PersonIdentityKeys,
): IdentityGroup<T> | undefined {
	const byUrlMatch = keys.url ? byUrl.get(keys.url) : undefined;
	if (byUrlMatch) return byUrlMatch;
	return keys.nameTitle ? byNameTitle.get(keys.nameTitle) : undefined;
}

/** Groups items sharing a canonical LinkedIn URL, or a normalized name, title and domain, keeping the first item of each group as canonical and the rest as duplicates in encounter order. */
export function groupByPersonIdentity<T>(
	items: readonly T[],
	identityOf: (item: T) => CandidateIdentity,
	domain: string,
): Array<IdentityGroup<T>> {
	const groups: Array<IdentityGroup<T>> = [];
	const byUrl = new Map<string, IdentityGroup<T>>();
	const byNameTitle = new Map<string, IdentityGroup<T>>();
	for (const item of items) {
		const keys = personIdentityKeys(identityOf(item), domain);
		const existing = existingGroup(byUrl, byNameTitle, keys);
		if (existing) {
			existing.duplicates.push(item);
			continue;
		}
		const group: IdentityGroup<T> = { canonical: item, duplicates: [] };
		groups.push(group);
		if (keys.url) byUrl.set(keys.url, group);
		if (keys.nameTitle) byNameTitle.set(keys.nameTitle, group);
	}
	return groups;
}
