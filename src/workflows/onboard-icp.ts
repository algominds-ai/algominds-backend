import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import {
	assertUnderDailyCeiling,
	closeRun,
	createIcp,
	openRun,
	recordRunSpend,
} from "@/core/db/queries";
import { publicDomain } from "@/core/db/schema";
import type { SellerPage } from "@/core/onboard";
import { readSellerPages, writeSellerProfile } from "@/core/onboard";
import type { IcpSeller } from "@/core/synthesize";

const OnboardIcpPayloadSchema = z.object({
	domain: z.string().min(1),
	note: z.string().nullish(),
	organizationId: z.string().min(1),
});

export type OnboardIcpPayload = z.infer<typeof OnboardIcpPayloadSchema>;

export type OnboardIcpSummary = {
	icpId: string;
	costDollars: number;
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
	description: string;
	seller: IcpSeller;
	costDollars: number;
};

type PersistIcpInput = {
	env: Env;
	runId: string;
	organizationId: string;
	domain: string;
	built: BuiltIcp;
};

/** Writes the profile, points the already-open run at it, and closes the run with what it spent. Returns the new profile's id. */
async function persistIcp(input: PersistIcpInput): Promise<string> {
	const { env, runId, organizationId, domain, built } = input;
	const row = await createIcp(env, {
		domain,
		organizationId,
		description: built.description,
		seller: built.seller,
	});
	await closeRun(env, runId, {
		status: "complete",
		costDollars: built.costDollars,
		icpId: row.id,
	});
	return row.id;
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

		await step.do("check-spend", config.stepConfig.databaseCall, () =>
			assertUnderDailyCeiling(this.env, payload.organizationId),
		);

		await step.do("open-run", config.stepConfig.databaseCall, async () => {
			await openRun(this.env, {
				id: runId,
				organizationId: payload.organizationId,
				capability: "onboarding",
				status: "running",
			});
		});

		const read: ReadSellerStep = await step.do(
			"read-seller",
			config.stepConfig.paidCall,
			async () => {
				const result = await readSellerPages(this.env, domain);
				return { pages: result.pages, costDollars: result.ledger.total() };
			},
		);
		await step.do("bank-search", config.stepConfig.databaseCall, () =>
			recordRunSpend(this.env, runId, read.costDollars),
		);

		const written = await step.do(
			"write-profile",
			config.stepConfig.paidCall,
			() =>
				writeSellerProfile(
					this.env,
					domain,
					read.pages,
					payload.note ?? null,
				).then((result) => ({
					description: result.description,
					seller: result.seller,
					costDollars: result.ledger.total(),
				})),
		);
		const built: BuiltIcp = {
			description: written.description,
			seller: written.seller,
			costDollars: read.costDollars + written.costDollars,
		};

		const icpId = await step.do(
			"save-icp",
			config.stepConfig.databaseCall,
			() =>
				persistIcp({
					env: this.env,
					runId,
					organizationId: payload.organizationId,
					domain,
					built,
				}),
		);

		return { icpId, costDollars: built.costDollars };
	}
}
