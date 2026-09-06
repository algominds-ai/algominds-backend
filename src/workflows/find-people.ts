import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import { addPartialSpend, CostLedger, PartialSpendError } from "@/core/cost";
import {
	assertUnderDailyCeiling,
	closeErroredRun,
	closeRun,
	loadIcp,
	openRun,
	recordRunSpend,
} from "@/core/db/queries";
import type { IcpDoc } from "@/core/icp";
import { IcpDocSchema } from "@/core/icp";
import type { ResolvedBuyer } from "@/core/people/buyer";
import { resolveBuyer } from "@/core/people/buyer";
import {
	deriveProviderHints,
	EMPTY_PROVIDER_HINTS,
} from "@/core/people/roster";
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

type ProviderHintsPurchase = {
	hints: Awaited<ReturnType<typeof deriveProviderHints>>;
	costDollars: number;
	error: string | null;
};

async function purchaseProviderHints(input: {
	step: WorkflowStep;
	env: Env;
	target: readonly TargetCompany[];
	buyer: ResolvedBuyer;
	instanceId: string;
	priorSpend: number;
}): Promise<ProviderHintsPurchase> {
	const { step, env, target, buyer, instanceId, priorSpend } = input;
	const provider = await step.do(
		"derive-people-provider-hints",
		config.stepConfig.paidCall,
		async (): Promise<ProviderHintsPurchase> => {
			if (target.length === 0) {
				return { hints: EMPTY_PROVIDER_HINTS, costDollars: 0, error: null };
			}
			const ledger = new CostLedger();
			try {
				const hints = await deriveProviderHints(buyer, env, ledger);
				return { hints, costDollars: ledger.total(), error: null };
			} catch (error) {
				const spent =
					error instanceof PartialSpendError
						? error
						: addPartialSpend(error, ledger.total());
				const cause = spent.cause;
				return {
					hints: EMPTY_PROVIDER_HINTS,
					costDollars: spent.costDollars,
					error: cause instanceof Error ? cause.message : String(cause),
				};
			}
		},
	);
	const total = priorSpend + provider.costDollars;
	await step.do("bank-provider-hints", config.stepConfig.databaseCall, () =>
		recordRunSpend(env, instanceId, total),
	);
	return provider;
}

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

		const provider = await purchaseProviderHints({
			step,
			env: this.env,
			target: target.companies,
			buyer,
			instanceId: event.instanceId,
			priorSpend: opened.alreadySpent,
		});
		const providerSpend = opened.alreadySpent + provider.costDollars;
		if (provider.error) {
			throw new NonRetryableError(
				`findPeople: provider hints failed: ${provider.error}`,
			);
		}

		const companies = clampCompanies(target.companies, payload.maxCompanies);
		const loop = await runCompanies(
			{
				env: this.env,
				step,
				runId: event.instanceId,
				organizationId,
				buyer,
				profile,
				providerHints: provider.hints,
			},
			companies,
			providerSpend,
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
