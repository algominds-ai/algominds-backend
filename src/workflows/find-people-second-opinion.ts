import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";
import {
	employerOpinion,
	indexOpinion,
	type ProfileOpinionResult,
	profileOpinion,
} from "@/core/people/verify";
import { applyCostEntries } from "@/workflows/agent-poll";
import type { PickContext, PickEvidence } from "@/workflows/find-people-verify";

type IndexStepResult = {
	found: boolean;
	employer: string | null;
	employerCompanyId: string | null;
	reply: string;
	costEntries: CostEntry[];
};

type OrganizationAgreement = {
	employer: "SAME" | "DIFFERENT";
	byOrganizationId: true;
};

/** The deterministic agreement by Exa organization id, or null when either side's id is unknown and a model opinion is still needed. */
function organizationAgreement(
	organizationId: string | null,
	employerCompanyId: string | null,
): OrganizationAgreement | null {
	if (organizationId === null || employerCompanyId === null) return null;
	return {
		employer: organizationId === employerCompanyId ? "SAME" : "DIFFERENT",
		byOrganizationId: true,
	};
}

type AgreementOutcome = {
	verified: boolean;
	needsRescue: boolean;
	evidence: PickEvidence[];
};

/** Whether the index's employer agrees with the target company, and whether anything short of `SAME` should still get a profile rescue rather than an outright drop. */
async function resolveAgreement(
	pick: PickContext,
	indexResult: IndexStepResult,
	ledger: CostLedger,
): Promise<AgreementOutcome> {
	const agreement = organizationAgreement(
		pick.progress.exaOrganizationId,
		indexResult.employerCompanyId,
	);
	if (agreement) {
		return {
			verified: agreement.employer === "SAME",
			needsRescue: agreement.employer === "DIFFERENT",
			evidence: [{ kind: "verify-agree", body: agreement }],
		};
	}
	const employer = indexResult.employer ?? "";
	const agreeResult = await pick.ctx.step.do(
		`${pick.name}-agree`,
		config.stepConfig.paidCall,
		async () => {
			const stepLedger = new CostLedger();
			const result = await employerOpinion(
				{
					employer,
					company: pick.progress.companyName,
					domain: pick.progress.domain,
				},
				pick.ctx.env,
				stepLedger,
			);
			return {
				label: result.label,
				reply: result.reply,
				costEntries: stepLedger.toJSON().entries,
			};
		},
	);
	applyCostEntries(agreeResult.costEntries, ledger);
	return {
		verified: agreeResult.label === "SAME",
		needsRescue: agreeResult.label !== "SAME",
		evidence: [{ kind: "verify-agree", body: agreeResult.reply }],
	};
}

type ProfileStepResult = {
	employment: ProfileOpinionResult["employment"];
	reply: ProfileOpinionResult["reply"];
	costEntries: CostEntry[];
};

/**
 * The one bounded rescue for a pick the index either missed or placed
 * elsewhere: reads the candidate's own profile text and verifies only when
 * it shows them currently at the target company. No LinkedIn URL means no
 * rescue is possible, so the pick stays unverified.
 */
async function profileRescue(
	pick: PickContext,
	ledger: CostLedger,
): Promise<{ verified: boolean; evidence: PickEvidence }> {
	const url = pick.candidate.url;
	if (!url) {
		return {
			verified: false,
			evidence: { kind: "verify-profile", body: null },
		};
	}
	const outcome = await pick.ctx.step.do(
		`${pick.name}-profile`,
		config.stepConfig.paidCall,
		async (): Promise<ProfileStepResult> => {
			const stepLedger = new CostLedger();
			const result = await profileOpinion(
				{
					url,
					name: pick.candidate.name ?? "the candidate",
					company: pick.progress.companyName,
					domain: pick.progress.domain,
					title: pick.candidate.title ?? "",
				},
				pick.ctx.env,
				stepLedger,
			);
			return {
				employment: result.employment,
				reply: result.reply,
				costEntries: stepLedger.toJSON().entries,
			};
		},
	);
	applyCostEntries(outcome.costEntries, ledger);
	return {
		verified: outcome.employment === "CURRENT",
		evidence: { kind: "verify-profile", body: outcome.reply },
	};
}

/**
 * Asks the Exa people index for a second opinion on a pick the verdict agent
 * could not confirm first-party, then falls back to the candidate's own
 * profile text rather than dropping the pick outright when the index missed
 * them or placed them at a different company.
 */
export async function secondOpinion(
	pick: PickContext,
	ledger: CostLedger,
): Promise<{ verified: boolean; evidence: PickEvidence[] }> {
	const indexResult = await pick.ctx.step.do(
		`${pick.name}-index`,
		config.stepConfig.paidCall,
		async (): Promise<IndexStepResult> => {
			const stepLedger = new CostLedger();
			const result = await indexOpinion(
				{
					name: pick.candidate.name,
					title: pick.candidate.title ?? "",
					company: pick.candidate.company ?? pick.progress.companyName,
					url: pick.candidate.url,
				},
				pick.ctx.env,
				stepLedger,
			);
			return {
				found: result.found,
				employer: result.employer,
				employerCompanyId: result.employerCompanyId,
				reply: JSON.stringify(result.reply),
				costEntries: stepLedger.toJSON().entries,
			};
		},
	);
	applyCostEntries(indexResult.costEntries, ledger);
	const evidence: PickEvidence[] = [
		{ kind: "verify-index", body: indexResult.reply },
	];
	const agreement: AgreementOutcome =
		!indexResult.found || indexResult.employer === null
			? { verified: false, needsRescue: true, evidence: [] }
			: await resolveAgreement(pick, indexResult, ledger);
	evidence.push(...agreement.evidence);
	if (!agreement.needsRescue) return { verified: agreement.verified, evidence };
	const rescue = await profileRescue(pick, ledger);
	evidence.push(rescue.evidence);
	return { verified: rescue.verified, evidence };
}
