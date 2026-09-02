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
import { IcpDocSchema } from "@/core/synthesize";
import { loadTargetCompanies } from "@/workflows/find-people-target";

const SENIOR_BANDS = [
	"founder",
	"owner",
	"board-member",
	"partner",
	"c-suite",
	"vp",
	"director",
	"head",
] as const;

const BAND_VALUES = [
	...SENIOR_BANDS,
	"manager",
	"senior",
	"mid-level",
	"entry",
	"intern",
	"unknown",
] as const;

const BuyerSchema = z.object({
	mode: z.enum(["roster", "profile", "target"]),
	buyerSource: z.enum(["target", "captured", "description", "none"]),
	rubric: z.string().nullable(),
	bands: z.array(z.enum(BAND_VALUES)),
	keywordBands: z.array(
		z.object({ band: z.enum(BAND_VALUES), keywords: z.array(z.string()) }),
	),
});

type Buyer = z.infer<typeof BuyerSchema>;

const maxCompaniesField = z.number().int().positive().optional();

const FindPeoplePayloadSchema = z.union([
	z.object({
		runId: z.string().min(1),
		maxCompanies: maxCompaniesField,
		organizationId: z.string().min(1),
	}),
	z.object({
		domains: z.array(z.string().min(1)).min(1),
		maxCompanies: maxCompaniesField,
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
	mode: Buyer["mode"];
	buyerSource: Buyer["buyerSource"];
};

function resolveBuyer(): Buyer {
	return BuyerSchema.parse({
		mode: "roster",
		buyerSource: "none",
		rubric: null,
		bands: SENIOR_BANDS,
		keywordBands: [],
	});
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

		await step.do("load-profile", config.stepConfig.databaseCall, async () => {
			const icpRow = await loadIcp(this.env, target.icpId);
			if (!icpRow) {
				throw new NonRetryableError(`findPeople: unknown icp ${target.icpId}`);
			}
			if (icpRow.organizationId !== organizationId) {
				throw new NonRetryableError(
					`findPeople: icp ${target.icpId} does not belong to organization ${organizationId}`,
				);
			}
			return { doc: IcpDocSchema.parse(icpRow.doc) };
		});

		const buyer = await step.do(
			"resolve-buyer",
			config.stepConfig.databaseCall,
			async () => resolveBuyer(),
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

		for (const _company of target.companies) {
		}

		await step.do("close-run", config.stepConfig.databaseCall, () =>
			closeRun(this.env, event.instanceId, {
				status: "complete",
				costDollars: opened.alreadySpent,
			}),
		);

		return {
			companiesSearched: 0,
			peopleVerified: 0,
			peopleRoster: 0,
			costDollars: opened.alreadySpent,
			unknownDomains: target.unknownDomains,
			capped: false,
			mode: buyer.mode,
			buyerSource: buyer.buyerSource,
		};
	}
}
