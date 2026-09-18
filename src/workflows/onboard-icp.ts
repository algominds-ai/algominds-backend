import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import { type Purchase, purchase } from "@/core/cost";
import {
	assertUnderDailyCeiling,
	closeErroredRun,
	openRun,
	recordRunSpend,
	saveOnboardedIcp,
} from "@/core/db/queries";
import { publicDomain } from "@/core/db/schema";
import type { IcpDoc } from "@/core/icp";
import {
	readSellerPages,
	type SellerPage,
	targetingNoteSchema,
	writeSellerProfile,
} from "@/core/onboard";

const OnboardIcpPayloadSchema = z.object({
	domain: z.string().min(1),
	note: targetingNoteSchema.nullish(),
	organizationId: z.string().min(1),
});
export type OnboardIcpPayload = z.infer<typeof OnboardIcpPayloadSchema>;
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

/** Refuses a nonpublic seller at both automatic and explicit onboarding boundaries. */
export function publicHostname(domain: string): string {
	const host = publicDomain(domain);
	if (host === null)
		throw new NonRetryableError(`onboardIcp: not a public hostname: ${domain}`);
	return host;
}

/** Reads seller facts, extracts explicit targeting, and stores the full versioned profile atomically. */
export class OnboardIcpWorkflow extends WorkflowEntrypoint<
	Env,
	OnboardIcpPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<OnboardIcpPayload>>,
		step: WorkflowStep,
	): Promise<OnboardIcpSummary> {
		try {
			return await this.runToCompletion(event, step);
		} catch (error) {
			await step.do("close-errored", config.stepConfig.databaseCall, () =>
				closeErroredRun(this.env, event.instanceId),
			);
			throw error;
		}
	}

	private async runToCompletion(
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
		const opened = await step.do(
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
		const read: Purchase<SellerPage[]> = await step.do(
			ONBOARD_STEPS.readSeller,
			config.stepConfig.paidCall,
			() =>
				purchase(async () => {
					const result = await readSellerPages(this.env, domain);
					return { value: result.pages, costDollars: result.ledger.total() };
				}),
		);
		let costDollars = opened.alreadySpent + read.costDollars;
		await step.do(
			ONBOARD_STEPS.bankSearch,
			config.stepConfig.databaseCall,
			() => recordRunSpend(this.env, runId, costDollars),
		);
		if (read.error) throw new NonRetryableError(`onboardIcp: ${read.error}`);
		const written: Purchase<IcpDoc | null> = await step.do(
			ONBOARD_STEPS.writeProfile,
			config.stepConfig.paidCall,
			() =>
				purchase(async () => {
					const result = await writeSellerProfile(
						this.env,
						domain,
						read.value ?? [],
						payload.note ?? null,
					);
					return { value: result.profile, costDollars: result.ledger.total() };
				}),
		);
		costDollars += written.costDollars;
		await step.do(
			ONBOARD_STEPS.bankProfile,
			config.stepConfig.databaseCall,
			() => recordRunSpend(this.env, runId, costDollars),
		);
		if (written.error)
			throw new NonRetryableError(`onboardIcp: ${written.error}`);
		const doc = written.value;
		if (!doc)
			throw new NonRetryableError(
				`onboardIcp: no profile written for ${domain}`,
			);
		const icpId = await step.do(
			ONBOARD_STEPS.saveIcp,
			config.stepConfig.databaseCall,
			() =>
				saveOnboardedIcp(this.env, {
					runId,
					organizationId: payload.organizationId,
					domain,
					doc,
					costDollars,
				}),
		);
		return { icpId, costDollars, wroteProfile: true };
	}
}
