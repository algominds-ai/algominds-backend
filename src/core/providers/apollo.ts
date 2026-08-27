import { z } from "zod";
import type { Provider } from "@/core/providers/types";
import { RetryableProviderError } from "@/core/providers/waterfall";

const APOLLO_SEARCH_URL =
	"https://api.apollo.io/api/v1/mixed_people/api_search";

export const ApolloFilterSchema = z
	.object({
		person_titles: z.array(z.string()).optional(),
		person_seniorities: z.array(z.string()).optional(),
		person_department_or_subdepartments: z.array(z.string()).optional(),
		person_locations: z.array(z.string()).optional(),
		q_organization_domains_list: z.array(z.string()).max(1000).optional(),
		organization_num_employees_ranges: z.array(z.string()).optional(),
		q_keywords: z.string().optional(),
		page: z.number().int().positive().optional(),
		per_page: z.number().int().positive().max(100).optional(),
	})
	.strict();

export type ApolloSearchFilters = z.infer<typeof ApolloFilterSchema>;

const ApolloPersonSchema = z.object({
	id: z.string(),
	first_name: z.string(),
	last_name_obfuscated: z.string(),
	title: z.string().nullable().optional(),
	organization: z
		.object({ name: z.string().nullable().optional() })
		.nullable()
		.optional(),
	has_email: z.boolean(),
	has_direct_phone: z.boolean(),
	last_refreshed_at: z.string().nullable().optional(),
});

const ApolloSearchResponseSchema = z.object({
	total_entries: z.number(),
	people: z.array(ApolloPersonSchema),
});

export type ApolloCandidate = {
	id: string;
	firstName: string;
	lastNameObfuscated: string;
	title: string | null;
	organizationName: string | null;
	hasEmail: boolean;
	hasDirectPhone: boolean;
	lastRefreshedAt: string | null;
};

export type ApolloSearchResult = {
	totalEntries: number;
	candidates: ApolloCandidate[];
};

function toCandidate(
	person: z.infer<typeof ApolloPersonSchema>,
): ApolloCandidate {
	return {
		id: person.id,
		firstName: person.first_name,
		lastNameObfuscated: person.last_name_obfuscated,
		title: person.title ?? null,
		organizationName: person.organization?.name ?? null,
		hasEmail: person.has_email,
		hasDirectPhone: person.has_direct_phone,
		lastRefreshedAt: person.last_refreshed_at ?? null,
	};
}

/**
 * Searches Apollo's free people-search endpoint behind a closed filter
 * allow-list; prefer `person_seniorities` plus
 * `person_department_or_subdepartments` over `person_titles`, whose exact
 * matching returns far fewer rows on the same domain.
 */
export const apolloPeopleSearch: Provider<
	ApolloSearchFilters,
	ApolloSearchResult
> = {
	id: "apollo",
	channels: ["people"],
	cost: 0,
	async run(filters, env) {
		const body = ApolloFilterSchema.parse(filters);
		const apiKey = await env.APOLLO_API_KEY.get();
		const response = await fetch(APOLLO_SEARCH_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(body),
		});
		if (response.status === 429) {
			throw new RetryableProviderError("apollo people search rate limited");
		}
		if (!response.ok) return null;
		const parsed = ApolloSearchResponseSchema.safeParse(await response.json());
		if (!parsed.success) return null;
		return {
			totalEntries: parsed.data.total_entries,
			candidates: parsed.data.people.map(toCandidate),
		};
	},
};
