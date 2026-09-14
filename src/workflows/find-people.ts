import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import {
	assertUnderDailyCeiling,
	closeErroredRun,
	closeRun,
	loadIcp,
	openRun,
} from "@/core/db/queries";
import type { IcpDoc } from "@/core/icp";
import { IcpDocSchema } from "@/core/icp";
import type { ResolvedBuyer } from "@/core/people/buyer";
import { resolveBuyer } from "@/core/people/buyer";
import { peopleFindSchema } from "@/http/schemas";
import { runCompanies } from "@/workflows/find-people-company";
import type { TargetCompany } from "@/workflows/find-people-target";
import { loadTargetCompanies } from "@/workflows/find-people-target";

const FindPeoplePayloadSchema = z.union(
	peopleFindSchema.options.map((option) =>
		option.extend({ organizationId: z.string().min(1) }),
	),
);

export type FindPeoplePayload = z.infer<typeof FindPeoplePayloadSchema>;

export type FindPeopleSummary = {
	companiesSearched: number;
	peopleVerified: number;
	peopleRoster: number;
	costDollars: number;
	unknownDomains: string[];
	capped: boolean;
	mode: ResolvedBuyer["mode"];
	buyerSource: ResolvedBuyer["buyerSource"];
};

async function loadProfile(
	env: Env,
	icpId: string | null,
	organizationId: string,
): Promise<IcpDoc | null> {
	if (icpId === null) return null;
	const icpRow = await loadIcp(env, icpId);
	if (!icpRow) {
		throw new NonRetryableError(`findPeople: unknown icp ${icpId}`);
	}
	if (icpRow.organizationId !== organizationId) {
		throw new NonRetryableError(
			`findPeople: icp ${icpId} does not belong to organization ${organizationId}`,
		);
	}
	const parsed = IcpDocSchema.safeParse(icpRow.doc);
	if (!parsed.success)
		throw new NonRetryableError(
			"findPeople: legacy profile; onboard again with the original instructions",
		);
	return parsed.data;
}

/** Clamps a target company list to the caller's own `maxCompanies` and the single account-wide `limits.maxCompaniesPerPeopleRun` ceiling, whichever is smaller. */
export function clampCompanies(
	companies: readonly TargetCompany[],
	maxCompanies: number | undefined,
): TargetCompany[] {
	const limit = Math.min(
		maxCompanies ?? config.limits.defaultMaxCompaniesPerPeopleRun,
		config.limits.maxCompaniesPerPeopleRun,
	);
	return companies.slice(0, limit);
}

export class FindPeopleWorkflow extends WorkflowEntrypoint<
	Env,
	FindPeoplePayload
> {
	override async run(
		event: Readonly<WorkflowEvent<FindPeoplePayload>>,
		step: WorkflowStep,
	): Promise<FindPeopleSummary> {
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
		event: Readonly<WorkflowEvent<FindPeoplePayload>>,
		step: WorkflowStep,
	): Promise<FindPeopleSummary> {
		const payload = FindPeoplePayloadSchema.parse(event.payload);
		const organizationId = payload.organizationId;

		const target = await step.do(
			"load-companies",
			config.stepConfig.databaseCall,
			() => loadTargetCompanies(this.env, payload),
		);

		const profile = await step.do(
			"load-profile",
			config.stepConfig.databaseCall,
			() => loadProfile(this.env, target.icpId, organizationId),
		);

		const buyer = await step.do(
			"resolve-buyer",
			config.stepConfig.databaseCall,
			async () => resolveBuyer({ target: payload.target ?? null, profile }),
		);

		const opened = await step.do(
			"open-run",
			config.stepConfig.databaseCall,
			async () => {
				await assertUnderDailyCeiling(this.env, organizationId);
				const row = await openRun(this.env, {
					id: event.instanceId,
					organizationId,
					icpId: target.icpId,
					capability: "people",
					status: "running",
				});
				return { alreadySpent: row.costDollars };
			},
		);

		const companies = clampCompanies(target.companies, payload.maxCompanies);
		const loop = await runCompanies(
			{
				env: this.env,
				step,
				runId: event.instanceId,
				organizationId,
				buyer,
			},
			companies,
			opened.alreadySpent,
		);

		await step.do("close-run", config.stepConfig.databaseCall, () =>
			closeRun(this.env, event.instanceId, {
				status: loop.capped ? "capped" : "complete",
				costDollars: loop.costDollars,
			}),
		);

		return {
			companiesSearched: loop.companiesSearched,
			peopleVerified: loop.peopleVerified,
			peopleRoster: loop.peopleRoster,
			costDollars: loop.costDollars,
			unknownDomains: loop.unknownDomains,
			capped: loop.capped,
			mode: buyer.mode,
			buyerSource: buyer.buyerSource,
		};
	}
}
