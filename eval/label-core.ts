import { z } from "zod";

const REJECT_CATEGORY = /^reject:[a-z][a-z0-9-]*$/;
const SAME_AS_DOMAIN = /^same-as:[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Whether `label` is one a human may type: `accept`, `reject:<category>`, or `same-as:<domain>`. */
export function isValidLabel(label: string): boolean {
	return (
		label === "accept" ||
		REJECT_CATEGORY.test(label) ||
		SAME_AS_DOMAIN.test(label)
	);
}

export const LabelSchema = z
	.string()
	.nullable()
	.refine((value) => value === null || isValidLabel(value), {
		message: "label must be accept, reject:<category>, or same-as:<domain>",
	});

export const KeyEntrySchema = z.object({
	label: LabelSchema,
	name: z.string().nullable(),
	firstSeenRunId: z.string(),
	lastSeenAt: z.string(),
});

export type KeyEntry = z.infer<typeof KeyEntrySchema>;

export const KeyFileSchema = z.object({
	slug: z.string(),
	icpId: z.string(),
	companies: z.record(z.string(), KeyEntrySchema),
});

export type KeyFile = z.infer<typeof KeyFileSchema>;

export function emptyKeyFile(slug: string, icpId: string): KeyFile {
	return { slug, icpId, companies: {} };
}

export type StoredCompany = {
	domain: string;
	name: string;
	runId: string;
	foundAt: string;
};

/**
 * `key` with one new unlabelled entry added per domain in `stored` the key
 * does not already carry. An existing entry, labelled or not, is never
 * touched: the key only grows.
 */
export function mergeStoredCompanies(
	key: KeyFile,
	stored: readonly StoredCompany[],
): KeyFile {
	const companies = { ...key.companies };
	for (const company of stored) {
		if (company.domain in companies) continue;
		companies[company.domain] = {
			label: null,
			name: company.name,
			firstSeenRunId: company.runId,
			lastSeenAt: company.foundAt,
		};
	}
	return { ...key, companies };
}

export function unlabelledDomains(key: KeyFile): string[] {
	return Object.entries(key.companies)
		.filter(([, entry]) => entry.label === null)
		.map(([domain]) => domain)
		.sort();
}

export type CompanyDetail = {
	domain: string;
	name: string;
	industry: string | null;
	description: string | null;
	fitReason: string | null;
	citedPage: string | null;
};

/** The block printed to a reviewer for one company before it asks for a label. */
export function formatCompanyDetail(detail: CompanyDetail): string {
	const lines = [
		`${detail.domain} — ${detail.name}`,
		`  industry:    ${detail.industry ?? "(none)"}`,
		`  description: ${detail.description ?? "(none)"}`,
		`  fit reason:  ${detail.fitReason ?? "(none)"}`,
		`  cited page:  ${detail.citedPage ?? "(none)"}`,
	];
	return lines.join("\n");
}

export function sortedKeyFile(key: KeyFile): KeyFile {
	const companies: KeyFile["companies"] = {};
	for (const domain of Object.keys(key.companies).sort()) {
		const entry = key.companies[domain];
		if (entry) companies[domain] = entry;
	}
	return { ...key, companies };
}
