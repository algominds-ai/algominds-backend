import { z } from "zod";
import { CostLedger } from "@/core/cost";
import type { Provider } from "@/core/providers/types";
import { RetryableProviderError } from "@/core/providers/waterfall";

const FINDYMAIL_BASE_URL = "https://app.findymail.com";

const ROLE_LOCAL_PARTS = new Set([
	"info",
	"sales",
	"hello",
	"contact",
	"support",
	"admin",
	"team",
	"hi",
]);

const FindymailContactSchema = z.object({
	email: z.string().optional(),
	name: z.string().optional(),
	domain: z.string().optional(),
	linkedin_url: z.string().optional(),
	company: z.string().optional(),
	job_title: z.string().optional(),
	city: z.string().optional(),
	region: z.string().optional(),
	country: z.string().optional(),
});

const FindymailSearchResponseSchema = z.object({
	contact: FindymailContactSchema.nullable().optional(),
});

const FindymailVerifyResponseSchema = z.object({
	email: z.string(),
	verified: z.boolean(),
	provider: z.string().optional(),
});

const FindymailCreditsResponseSchema = z.object({
	credits: z.number(),
	verifier_credits: z.number(),
});

export type FindymailContact = z.infer<typeof FindymailContactSchema>;
type FoundContact = FindymailContact & { email: string };

export type FindymailFinder = "linkedin" | "name";
export type FindymailStatus = "verified" | "invalid" | "unknown";

export type FindymailInput = {
	linkedinUrl?: string;
	name?: string;
	domain?: string;
};

export type FindymailResult = {
	email: string;
	contact: FindymailContact;
	finder: FindymailFinder;
	status: FindymailStatus;
	ledger: CostLedger;
};

export type FindymailBalance = { credits: number; verifierCredits: number };

async function postFindymail<T>(
	path: string,
	body: unknown,
	env: Env,
	schema: z.ZodType<T>,
): Promise<T | null> {
	const apiKey = await env.FINDYMAIL_API_KEY.get();
	const response = await fetch(`${FINDYMAIL_BASE_URL}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (response.status === 429) {
		throw new RetryableProviderError(`findymail ${path} rate limited`);
	}
	if (!response.ok) return null;
	const parsed = schema.safeParse(await response.json());
	return parsed.success ? parsed.data : null;
}

export async function findymailSearchLinkedin(
	input: { linkedinUrl: string },
	env: Env,
	ledger: CostLedger,
): Promise<FoundContact | null> {
	const result = await postFindymail(
		"/api/search/linkedin",
		{ linkedin_url: input.linkedinUrl },
		env,
		FindymailSearchResponseSchema,
	);
	const contact = result?.contact;
	if (!contact?.email) return null;
	ledger.metered("findymail", "search-linkedin", 1, "credits");
	return { ...contact, email: contact.email };
}

export async function findymailSearchByName(
	input: { name: string; domain: string },
	env: Env,
	ledger: CostLedger,
): Promise<FoundContact | null> {
	const result = await postFindymail(
		"/api/search/name",
		{ name: input.name, domain: input.domain },
		env,
		FindymailSearchResponseSchema,
	);
	const contact = result?.contact;
	if (!contact?.email) return null;
	ledger.metered("findymail", "search-name", 1, "credits");
	return { ...contact, email: contact.email };
}

export async function findymailVerify(
	email: string,
	env: Env,
	ledger: CostLedger,
): Promise<boolean | null> {
	const result = await postFindymail(
		"/api/verify",
		{ email },
		env,
		FindymailVerifyResponseSchema,
	);
	if (!result) return null;
	ledger.metered("findymail", "verify", 1, "verifier_credits");
	return result.verified;
}

export async function findymailCredits(
	env: Env,
): Promise<FindymailBalance | null> {
	const apiKey = await env.FINDYMAIL_API_KEY.get();
	const response = await fetch(`${FINDYMAIL_BASE_URL}/api/credits`, {
		headers: { authorization: `Bearer ${apiKey}` },
	});
	if (response.status === 429) {
		throw new RetryableProviderError("findymail credits rate limited");
	}
	if (!response.ok) return null;
	const parsed = FindymailCreditsResponseSchema.safeParse(
		await response.json(),
	);
	if (!parsed.success) return null;
	return {
		credits: parsed.data.credits,
		verifierCredits: parsed.data.verifier_credits,
	};
}

function isRoleAddress(email: string): boolean {
	const localPart = email.toLowerCase().split("@")[0];
	return localPart !== undefined && ROLE_LOCAL_PARTS.has(localPart);
}

/**
 * Combines a found address with the verifier's answer into one of three
 * states. A role address never reaches `verified`, even when the verifier
 * agrees, and a missing verifier answer never reaches `verified` either.
 */
export function findymailStatus(
	email: string,
	verified: boolean | undefined,
): FindymailStatus {
	if (verified === undefined) return "unknown";
	if (!verified) return "invalid";
	return isRoleAddress(email) ? "invalid" : "verified";
}

async function resolveStatus(
	contact: FoundContact,
	env: Env,
	ledger: CostLedger,
): Promise<FindymailStatus> {
	const verified = await findymailVerify(contact.email, env, ledger);
	return findymailStatus(contact.email, verified ?? undefined);
}

export const findymailLinkedinProvider: Provider<
	FindymailInput,
	FindymailResult
> = {
	id: "findymail-linkedin",
	channels: ["email"],
	cost: 1,
	async run(input, env) {
		if (!input.linkedinUrl) return null;
		const ledger = new CostLedger();
		const contact = await findymailSearchLinkedin(
			{ linkedinUrl: input.linkedinUrl },
			env,
			ledger,
		);
		if (!contact) return null;
		const status = await resolveStatus(contact, env, ledger);
		return {
			email: contact.email,
			contact,
			finder: "linkedin",
			status,
			ledger,
		};
	},
};

export const findymailNameProvider: Provider<FindymailInput, FindymailResult> =
	{
		id: "findymail-name",
		channels: ["email"],
		cost: 1,
		async run(input, env) {
			if (!input.name || !input.domain) return null;
			const ledger = new CostLedger();
			const contact = await findymailSearchByName(
				{ name: input.name, domain: input.domain },
				env,
				ledger,
			);
			if (!contact) return null;
			const status = await resolveStatus(contact, env, ledger);
			return { email: contact.email, contact, finder: "name", status, ledger };
		},
	};

export const FINDYMAIL_EMAIL_PROVIDERS: Provider<
	FindymailInput,
	FindymailResult
>[] = [findymailLinkedinProvider, findymailNameProvider];
