import type { introspectWorkflowInstance } from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { readSellerPages, writeSellerProfile } from "@/core/onboard";
import type { IcpSeller } from "@/core/synthesize";
import { ONBOARD_STEPS } from "@/workflows/onboard-icp";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";

export function sellerFixture(domain: string): IcpSeller {
	return { domain, customers: ["Acme Corp"], competitorTest: "test" };
}

export function sellerPagesFixture(
	domain: string,
	costDollars = 0.01,
): { pages: { url: string; text: string }[]; costDollars: number } {
	return { pages: [{ url: `https://${domain}/`, text: "" }], costDollars };
}

type WriteProfileOverrides = {
	description?: string | null;
	wroteProfile?: boolean;
	costDollars?: number;
};

export function writeProfileFixture(
	domain: string,
	overrides: WriteProfileOverrides = {},
) {
	return {
		description:
			"description" in overrides ? overrides.description : "a mocked profile",
		seller: sellerFixture(domain),
		wroteProfile: overrides.wroteProfile ?? true,
		costDollars: overrides.costDollars ?? 0.01,
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
	if (written.description === null) {
		throw new NonRetryableError(`onboard: no profile written for ${domain}`);
	}
	return { ...written, description: written.description };
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

type ProfileReplyOverrides = {
	buyer?: {
		rubric: string;
		bands: readonly string[];
		keywordBands: { band: string; keywords: string[] }[];
	} | null;
};

export function profileReply(overrides: ProfileReplyOverrides = {}): string {
	return JSON.stringify({
		description: "a four paragraph ideal customer profile",
		customers: ["Acme Corp"],
		competitorTest: "A competitor sells the same tooling to other vendors.",
		buyer: null,
		requirements: [
			{
				id: "r1",
				text: "runs its own delivery team",
				kind: "hard",
				proof: "record",
				windowDays: null,
			},
		],
		sizeBand: null,
		...overrides,
	});
}
