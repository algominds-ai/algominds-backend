import type {
	ApolloSearchFilters,
	ApolloSearchResult,
} from "@/core/providers/apollo";
import { apolloPeopleSearch } from "@/core/providers/apollo";
import type {
	FindymailInput,
	FindymailResult,
} from "@/core/providers/findymail";
import { FINDYMAIL_EMAIL_PROVIDERS } from "@/core/providers/findymail";
import type { Provider } from "@/core/providers/types";

export const PEOPLE: Provider<ApolloSearchFilters, ApolloSearchResult>[] = [
	apolloPeopleSearch,
];

export const EMAIL: Provider<FindymailInput, FindymailResult>[] = [
	...FINDYMAIL_EMAIL_PROVIDERS,
];

export const COMPANY: Provider<never, never>[] = [];
export const EMPLOYMENT: Provider<never, never>[] = [];
export const LINKEDIN: Provider<never, never>[] = [];
