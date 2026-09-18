import { exaAgentEmailProvider } from "@/core/providers/exa/agent-email";
import type {
	FindymailInput,
	FindymailResult,
} from "@/core/providers/findymail/index";
import { FINDYMAIL_EMAIL_PROVIDERS } from "@/core/providers/findymail/index";
import type { Provider } from "@/core/providers/types";

export const EMAIL: Provider<FindymailInput, FindymailResult>[] = [
	...FINDYMAIL_EMAIL_PROVIDERS,
	exaAgentEmailProvider,
];
