import { z } from "zod";
import { config } from "@/config";
import { CostLedger } from "@/core/cost";
import {
	agentLinkedinUrl,
	getAgentRunOutput,
	startAgentRun,
} from "@/core/providers/exa/agent";
import type {
	FindymailContact,
	FindymailInput,
	FindymailResult,
} from "@/core/providers/findymail/index";
import type { Provider } from "@/core/providers/types";
import { RetryableProviderError } from "@/core/providers/waterfall";

const EFFORT = config.enrich.exaAgentEffort;
const POLL_INTERVAL_SECONDS = config.enrich.exaAgentPollIntervalSeconds;
const MAX_POLL_ATTEMPTS = config.enrich.exaAgentMaxPollAttempts;

const ExaAgentEmailContactSchema = z.object({
	fullName: z.string().nullish(),
	title: z.string().nullish(),
	email: z
		.string()
		.nullish()
		.transform((value) =>
			value && z.email().safeParse(value).success ? value : null,
		),
	linkedinUrl: agentLinkedinUrl,
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
 * Polls one agent run until it completes. Returns the contact, or null on a
 * timeout or a retryable vendor error. See `docs/solutions/agent-run-polling.md`.
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
 * Starts one agent email run. Returns null when the vendor is rate limited or
 * unavailable, so the caller's enrich batch is not retried and billed again
 * for every other provider it already ran.
 */
async function startEmailRun(
	description: string,
	env: Env,
): Promise<{ id: string } | null> {
	try {
		return await startAgentRun(
			{
				query: `Find the work email address for ${description}.`,
				systemPrompt:
					"Only report an email you found direct evidence for, and name the exact page it came from.",
				effort: EFFORT,
				outputSchema: PERSON_EMAIL_OUTPUT_SCHEMA,
			},
			env,
		);
	} catch (error) {
		if (error instanceof RetryableProviderError) return null;
		throw error;
	}
}

/**
 * Searches for a person's work email through Exa's Agent API, the waterfall's
 * slowest and last email provider, so it only ever runs on what Findymail
 * missed. A found address carries the agent's cited source URL.
 */
export const exaAgentEmailProvider: Provider<FindymailInput, FindymailResult> =
	{
		id: "exa-agent-email",
		channels: ["email"],
		cost: 3,
		async run(input, env, ledger = new CostLedger()) {
			const description = personDescription(input);
			if (!description) return null;
			const started = await startEmailRun(description, env);
			if (!started) return null;
			const person = await pollPersonEmail(started.id, env, ledger);
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
