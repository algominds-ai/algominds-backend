import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import {
	assertUnderDailyCeiling,
	openRun,
	recordRunSpend,
	saveOnboardedIcp,
} from "@/core/db/queries";
import { publicDomain } from "@/core/db/schema";
import type { SellerPage } from "@/core/onboard";
import { readSellerPages, writeSellerProfile } from "@/core/onboard";
import type { Requirement } from "@/core/requirements";
import type { IcpBuyer, IcpSeller } from "@/core/synthesize";

const OnboardIcpPayloadSchema = z.object({
	domain: z.string().min(1),
	note: z.string().nullish(),
	organizationId: z.string().min(1),
});

export type OnboardIcpPayload = z.infer<typeof OnboardIcpPayloadSchema>;

/** The name of every durable step this workflow runs. A test mocking a paid step by hand would silently stop mocking it after a rename. */
export const ONBOARD_STEPS = {
	checkSpend: "check-spend",
	openRun: "open-run",
	readSeller: "read-seller",
	bankSearch: "bank-search",
	writeProfile: "write-profile",
	bankProfile: "bank-profile",
	saveIcp: "save-icp",
} as const;

export type OnboardIcpSummary = {
	icpId: string;
	costDollars: number;
	wroteProfile: boolean;
};

/** `domain` as a public hostname, or a `NonRetryableError`. Both entry paths cross this, so it is the one place the refusal belongs. */
export function publicHostname(domain: string): string {
	const host = publicDomain(domain);
	if (host === null) {
		throw new NonRetryableError(`onboardIcp: not a public hostname: ${domain}`);
	}
	return host;
}

type ReadSellerStep = { pages: SellerPage[]; costDollars: number };

/** The profile plus its cost as plain data. See `docs/solutions/onboarding-run-accounting.md`. */
type BuiltIcp = {
	description: string | null;
	seller: IcpSeller;
	buyer: IcpBuyer | null;
	requirements: Requirement[];
	wroteProfile: boolean;
	costDollars: number;
};

type BuyProfileInput = {
	env: Env;
	step: WorkflowStep;
	runId: string;
	domain: string;
	note: string | null;
	alreadySpent: number;
};

/** Buys the seller's pages and then the profile, banking each purchase before the next, and returns the profile with everything the run has spent. */
async function buyProfile(input: BuyProfileInput): Promise<BuiltIcp> {
	const { env, step, runId, domain, note, alreadySpent } = input;
	const read: ReadSellerStep = await step.do(
		ONBOARD_STEPS.readSeller,
		config.stepConfig.paidCall,
		async () => {
			const result = await readSellerPages(env, domain);
			return { pages: result.pages, costDollars: result.ledger.total() };
		},
	);
	await step.do(ONBOARD_STEPS.bankSearch, config.stepConfig.databaseCall, () =>
		recordRunSpend(env, runId, alreadySpent + read.costDollars),
	);

	const written = await step.do(
		ONBOARD_STEPS.writeProfile,
		config.stepConfig.paidCall,
		() =>
			writeSellerProfile(env, domain, read.pages, note).then((result) => ({
				description: result.description,
				seller: result.seller,
				buyer: result.buyer,
				requirements: result.requirements,
				wroteProfile: result.wroteProfile,
				costDollars: result.ledger.total(),
			})),
	);
	const costDollars = alreadySpent + read.costDollars + written.costDollars;
	await step.do(ONBOARD_STEPS.bankProfile, config.stepConfig.databaseCall, () =>
		recordRunSpend(env, runId, costDollars),
	);
	return { ...written, costDollars };
}

type PersistIcpInput = {
	env: Env;
	runId: string;
	organizationId: string;
	domain: string;
	built: BuiltIcp & { description: string };
};

/** Writes the profile and closes the run against it in one transaction. Returns the new profile's id. */
async function persistIcp(input: PersistIcpInput): Promise<string> {
	const { env, runId, organizationId, domain, built } = input;
	return saveOnboardedIcp(env, {
		runId,
		domain,
		organizationId,
		description: built.description,
		seller: built.seller,
		buyer: built.buyer,
		requirements: built.requirements,
		costDollars: built.costDollars,
	});
}

/**
 * Reads a seller's own site into an ideal customer profile and stores it,
 * off the request path. Its spend counts against the account's daily
 * ceiling exactly as a companies or people run's does.
 */
export class OnboardIcpWorkflow extends WorkflowEntrypoint<
	Env,
	OnboardIcpPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<OnboardIcpPayload>>,
		step: WorkflowStep,
	): Promise<OnboardIcpSummary> {
		const payload = OnboardIcpPayloadSchema.parse(event.payload);
		const domain = publicHostname(payload.domain);

		const runId = event.instanceId;

		await step.do(
			ONBOARD_STEPS.checkSpend,
			config.stepConfig.databaseCall,
			() => assertUnderDailyCeiling(this.env, payload.organizationId),
		);

		const alreadySpent = await step.do(
			ONBOARD_STEPS.openRun,
			config.stepConfig.databaseCall,
			async () => {
				const row = await openRun(this.env, {
					id: runId,
					organizationId: payload.organizationId,
					capability: "onboarding",
					status: "running",
				});
				return { alreadySpent: row.costDollars };
			},
		);

		const written = await buyProfile({
			env: this.env,
			step,
			runId,
			domain,
			note: payload.note ?? null,
			alreadySpent: alreadySpent.alreadySpent,
		});

		const description = written.description;
		if (description === null) {
			throw new NonRetryableError(
				`onboardIcp: no profile written and no note given for ${domain}`,
			);
		}

		const icpId = await step.do(
			ONBOARD_STEPS.saveIcp,
			config.stepConfig.databaseCall,
			() =>
				persistIcp({
					env: this.env,
					runId,
					organizationId: payload.organizationId,
					domain,
					built: { ...written, description },
				}),
		);

		return {
			icpId,
			costDollars: written.costDollars,
			wroteProfile: written.wroteProfile,
		};
	}
}
