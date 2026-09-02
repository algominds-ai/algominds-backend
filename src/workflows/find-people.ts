import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import {
	assertUnderDailyCeiling,
	closeRun,
	loadIcp,
	openRun,
} from "@/core/db/queries";
import type { ResolvedBuyer } from "@/core/people/buyer";
import { resolveBuyer } from "@/core/people/buyer";
import type { IcpDoc } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";
import { runCompanies } from "@/workflows/find-people-company";
import type { TargetCompany } from "@/workflows/find-people-target";
import { loadTargetCompanies } from "@/workflows/find-people-target";

const maxCompaniesField = z.number().int().positive().optional();
const targetField = z
	.union([z.array(z.string().min(1)).min(1), z.string().min(1)])
	.optional();

const FindPeoplePayloadSchema = z.union([
	z.object({
		runId: z.string().min(1),
		maxCompanies: maxCompaniesField,
		target: targetField,
		organizationId: z.string().min(1),
	}),
	z.object({
		domains: z.array(z.string().min(1)).min(1),
		maxCompanies: maxCompaniesField,
		target: targetField,
		icpId: z.uuid().optional(),
		organizationId: z.string().min(1),
	}),
]);

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
	return IcpDocSchema.parse(icpRow.doc);
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
				profile,
			},
			companies,
			opened.alreadySpent,
		);

		await step.do("close-run", config.stepConfig.databaseCall, () =>
			closeRun(this.env, event.instanceId, {
				status: "complete",
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
