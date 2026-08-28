import type {
	ApolloSearchFilters,
	ApolloSearchResult,
} from "@/core/providers/apollo/index";
import { apolloPeopleSearch } from "@/core/providers/apollo/index";
import { exaAgentEmailProvider } from "@/core/providers/exa/agent-email";
import type {
	FindymailInput,
	FindymailResult,
} from "@/core/providers/findymail/index";
import { FINDYMAIL_EMAIL_PROVIDERS } from "@/core/providers/findymail/index";
import type { Provider } from "@/core/providers/types";

export const PEOPLE: Provider<ApolloSearchFilters, ApolloSearchResult>[] = [
	apolloPeopleSearch,
];

export const EMAIL: Provider<FindymailInput, FindymailResult>[] = [
	...FINDYMAIL_EMAIL_PROVIDERS,
	exaAgentEmailProvider,
];

export const COMPANY: Provider<never, never>[] = [];
export const EMPLOYMENT: Provider<never, never>[] = [];
export const LINKEDIN: Provider<never, never>[] = [];
