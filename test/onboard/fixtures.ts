import type { introspectWorkflowInstance } from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { IcpDoc, IcpSeller } from "@/core/icp";
import { readSellerPages, writeSellerProfile } from "@/core/onboard";
import { ONBOARD_STEPS } from "@/workflows/onboard-icp";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";
import { profileFixture, requirementFixture } from "../support/icp";

export function sellerFixture(domain: string): IcpSeller {
	return {
		domain,
		description: "Acme sells tooling.",
		customers: ["Acme Corp"],
		sourceUrls: [`https://${domain}/`],
	};
}

export function sellerPagesFixture(domain: string, costDollars = 0.01) {
	return {
		value: [{ url: `https://${domain}/`, text: "Acme sells tooling." }],
		costDollars,
		error: null,
	};
}

type WriteProfileOverrides = {
	profile?: IcpDoc | null;
	costDollars?: number;
	error?: string | null;
};
export function writeProfileFixture(
	domain: string,
	overrides: WriteProfileOverrides = {},
) {
	return {
		value:
			"profile" in overrides
				? overrides.profile
				: profileFixture({}, null, domain),
		costDollars: overrides.costDollars ?? 0.01,
		error: overrides.error ?? null,
	};
}

type WorkflowInstance = Awaited<ReturnType<typeof introspectWorkflowInstance>>;

/** Mocks a full successful onboarding run: checks spend, reads the seller, writes the profile, and saves it. */
export async function primeOnboardStart(
	instance: WorkflowInstance,
	domain: string,
	overrides: WriteProfileOverrides = {},
): Promise<void> {
	await instance.modify(async (m) => {
		await m.mockStepResult({ name: ONBOARD_STEPS.checkSpend }, {});
		await m.mockStepResult(
			{ name: ONBOARD_STEPS.openRun },
			{ alreadySpent: 0 },
		);
		await m.mockStepResult(
			{ name: ONBOARD_STEPS.readSeller },
			sellerPagesFixture(domain),
		);
		await m.mockStepResult({ name: ONBOARD_STEPS.bankSearch }, {});
		await m.mockStepResult(
			{ name: ONBOARD_STEPS.writeProfile },
			writeProfileFixture(domain, overrides),
		);
		await m.mockStepResult({ name: ONBOARD_STEPS.saveIcp }, "mocked-icp-id");
	});
}

/** Mocks only the paid steps of an onboarding run: reading the seller and writing the profile. */
export async function primeOnboardProfile(
	instance: WorkflowInstance,
	domain: string,
	overrides: WriteProfileOverrides = {},
): Promise<void> {
	await instance.modify(async (m) => {
		await m.mockStepResult(
			{ name: ONBOARD_STEPS.readSeller },
			sellerPagesFixture(domain),
		);
		await m.mockStepResult(
			{ name: ONBOARD_STEPS.writeProfile },
			writeProfileFixture(domain, overrides),
		);
	});
}

export function onboardEnv(): Env {
	return fakeModelEnv({}, fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }));
}

export async function buildIcp(env: Env, domain: string, note?: string | null) {
	const read = await readSellerPages(env, domain);
	const written = await writeSellerProfile(
		env,
		domain,
		read.pages,
		note ?? null,
	);
	if (!written.profile)
		throw new NonRetryableError(`onboard: no profile written for ${domain}`);
	return written;
}

const ModelRequestBodySchema = z.object({
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

export function messageContent(body: unknown, role: string): string {
	const { messages } = ModelRequestBodySchema.parse(body);
	const message = messages.find((entry) => entry.role === role);
	if (!message) throw new Error(`expected a ${role} message`);
	return message.content;
}

type ProfileReplyOverrides = Partial<IcpDoc["icp"]> & { domain?: string };
export function profileReply(overrides: ProfileReplyOverrides = {}): string {
	const { domain = "acme.example", ...target } = overrides;
	const doc = profileFixture(
		{
			requirements: [requirementFixture("runs its own delivery team")],
			...target,
		},
		null,
		domain,
	);
	return JSON.stringify({ seller: sellerFixture(domain), icp: doc.icp });
}
