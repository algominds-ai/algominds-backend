import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { DedupeRow } from "@/core/people/dedupe";
import { RetryableProviderError } from "@/core/providers/waterfall";

const DECISION_MAKERS_URL =
	"https://app.getleads.io/api/v1/contacts/lookup/decision-makers";
const TIMEOUT_MS = 20_000;
const SOURCE = "getleads:decision-makers";

const ContactSchema = z.object({
	first_name: z.string().nullish(),
	last_name: z.string().nullish(),
	job_title: z.string().nullish(),
	person_linkedin_url: z.string().nullish(),
	person_city: z.string().nullish(),
	person_country_name: z.string().nullish(),
	org_company_name: z.string().nullish(),
});

const DecisionMakersSchema = z.object({
	contacts: z.array(ContactSchema),
	query_credits_used: z.coerce.number().nullish(),
});

export type GetleadsRoster = {
	rows: DedupeRow[];
	raw: string;
	creditsUsed: number;
};

function toRow(contact: z.infer<typeof ContactSchema>): DedupeRow {
	const name = [contact.first_name, contact.last_name]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	const location = [contact.person_city, contact.person_country_name]
		.filter((part): part is string => Boolean(part))
		.join(", ");
	return {
		name: name || null,
		title: contact.job_title ?? null,
		company: contact.org_company_name ?? null,
		url: contact.person_linkedin_url ?? null,
		location: location || null,
		since: null,
		source: SOURCE,
	};
}

async function requestDecisionMakers(
	key: string,
	domain: string,
): Promise<Response> {
	try {
		return await fetch(DECISION_MAKERS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ domain }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new RetryableProviderError(`getleads request failed: ${reason}`);
	}
}

/**
 * The senior people GetLeads holds for one company domain, as roster rows,
 * with the raw reply and the credits the call consumed. Throws
 * `RetryableProviderError` on 429, 5xx, a timeout, or any other transport
 * failure; `NonRetryableError` on any other failure or a reply that does not
 * match the expected shape.
 */
export async function getleadsDecisionMakers(
	env: Env,
	domain: string,
): Promise<GetleadsRoster> {
	const key = await env.GL_API_KEY.get();
	const response = await requestDecisionMakers(key, domain);
	const raw = await response.text();
	if (response.status === 429 || response.status >= 500) {
		throw new RetryableProviderError(`getleads ${response.status}`);
	}
	if (!response.ok) {
		throw new NonRetryableError(
			`getleads ${response.status}: ${raw.slice(0, 200)}`,
		);
	}
	const parsed = DecisionMakersSchema.safeParse(JSON.parse(raw));
	if (!parsed.success) {
		throw new NonRetryableError(
			"getleads: reply did not match the expected shape",
		);
	}
	return {
		rows: parsed.data.contacts.map(toRow),
		raw,
		creditsUsed: parsed.data.query_credits_used ?? parsed.data.contacts.length,
	};
}
