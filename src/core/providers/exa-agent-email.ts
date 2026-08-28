import { z } from "zod";
import { config } from "@/config";
import { CostLedger } from "@/core/cost";
import { getAgentRunOutput, startAgentRun } from "@/core/providers/exa-agent";
import type {
	FindymailContact,
	FindymailInput,
	FindymailResult,
} from "@/core/providers/findymail";
import type { Provider } from "@/core/providers/types";
import { RetryableProviderError } from "@/core/providers/waterfall";

const EFFORT = config.companies.exaAgentEffort;
const POLL_INTERVAL_SECONDS = config.companies.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.companies.exaAgentMaxPollAttempts;

const ExaAgentEmailContactSchema = z.object({
	fullName: z.string().nullish(),
	title: z.string().nullish(),
	email: z.string().nullish(),
	linkedinUrl: z.string().nullish(),
	source: z.string().nullish(),
});

type ExaAgentEmailContact = z.infer<typeof ExaAgentEmailContactSchema>;

const PERSON_EMAIL_OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		fullName: { type: "string" },
		title: { type: "string" },
		email: { type: "string" },
		linkedinUrl: { type: "string" },
		source: { type: "string" },
	},
};

function personDescription(input: FindymailInput): string | null {
	if (input.name && input.domain) return `${input.name} at ${input.domain}`;
	if (input.linkedinUrl) return `the person at ${input.linkedinUrl}`;
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOnce(
	id: string,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentEmailContact | null> {
	try {
		const run = await getAgentRunOutput(
			id,
			env,
			ledger,
			ExaAgentEmailContactSchema,
		);
		return run.status === "completed" ? run.output : null;
	} catch (error) {
		if (error instanceof RetryableProviderError) return null;
		throw error;
	}
}

/**
 * Polls one agent run to completion, sleeping between attempts, bounded by
 * `MAX_POLL_ATTEMPTS`. Returns null on a timeout, the same as a miss, since
 * this waterfall provider has no next provider to fall back to. A retryable
 * vendor error ends that one poll rather than the caller's step, because the
 * run is already paid for and a step retry would start and bill a second one.
 */
async function pollPersonEmail(
	id: string,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentEmailContact | null> {
	for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
		const output = await pollOnce(id, env, ledger);
		if (output) return output;
		if (attempt < MAX_POLL_ATTEMPTS) {
			await sleep(POLL_INTERVAL_SECONDS * 1000);
		}
	}
	return null;
}

function toContact(
	input: FindymailInput,
	person: ExaAgentEmailContact,
): FindymailContact {
	return {
		...(person.email ? { email: person.email } : {}),
		...(person.fullName ? { name: person.fullName } : {}),
		...(input.domain ? { domain: input.domain } : {}),
		...(person.linkedinUrl ? { linkedin_url: person.linkedinUrl } : {}),
		...(person.title ? { job_title: person.title } : {}),
	};
}

/**
 * Searches for a person's work email through Exa's Agent API, the
 * waterfall's slowest and last email provider: a full run takes on the
 * order of half a minute, so it only ever runs on what Findymail missed. A
 * found address carries the agent's cited source URL, not just a finder
 * label, because the citation is the reason to prefer this over a plain
 * lookup.
 */
export const exaAgentEmailProvider: Provider<FindymailInput, FindymailResult> =
	{
		id: "exa-agent-email",
		channels: ["email"],
		cost: 3,
		async run(input, env, ledger = new CostLedger()) {
			const description = personDescription(input);
			if (!description) return null;
			const { id } = await startAgentRun(
				{
					query: `Find the work email address for ${description}.`,
					systemPrompt:
						"Only report an email you found direct evidence for, and name the exact page it came from.",
					effort: EFFORT,
					outputSchema: PERSON_EMAIL_OUTPUT_SCHEMA,
				},
				env,
			);
			const person = await pollPersonEmail(id, env, ledger);
			if (!person?.email) return null;
			return {
				email: person.email,
				contact: toContact(input, person),
				finder: "agent",
				status: "unknown",
				...(person.source ? { source: person.source } : {}),
			};
		},
	};
