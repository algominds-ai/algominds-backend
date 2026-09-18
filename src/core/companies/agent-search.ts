import { z } from "zod";
import type {
	ExaAgentCompany,
	ExaAgentRunRequest,
} from "@/core/providers/exa/agent";
import type { ExaResult, ExaSearchResult } from "@/core/providers/exa/search";
import {
	CompanyEvidenceSchema,
	CompanyRecordSchema,
} from "@/core/providers/exa/search";
import type { IcpDoc, SearchPlan } from "@/core/synthesize";

const AgentCompanyRequestSchema = z.object({
	name: z.string(),
	website: z.string(),
	linkedinUrl: z.string(),
	description: z.string(),
	evidence: z.array(CompanyEvidenceSchema),
});

const AGENT_INSTRUCTIONS = [
	"Find companies for the scoped offer and grouped company requirements in the account.",
	"Required groups are AND; anyOf alternatives are OR; allOf conditions are AND. Preferences never exclude.",
	"Do not return the seller itself. A customer of a competing vendor is not itself a competitor.",
	"Use the company's own website and verified LinkedIn company URL; never invent either.",
	"Give its description. Return evidence for the relevant conditions with sourceUrl and a verbatim quote,",
	"using conditionId rN.aN.cN for the 1-based requirement, anyOf alternative and allOf condition positions.",
	"Keep eventDate separate from publishedDate; a crawl or profile update never establishes an event date. Leave unsupported dates null.",
	"Check each requested event, publication or observation window against its own evidence.",
	"Return fewer companies, including an empty array, when evidence is insufficient. Never fabricate.",
].join(" ");

export type AgentRunInput = {
	plan: SearchPlan;
	count: number;
	today: string;
	icp: IcpDoc;
	excludeDomains: readonly string[];
};

export function buildAgentRunRequest(input: AgentRunInput): ExaAgentRunRequest {
	const { plan, count, today, icp, excludeDomains } = input;
	const { $schema: _schema, ...outputSchema } = z.toJSONSchema(
		z.object({
			companies: z.array(AgentCompanyRequestSchema).max(count),
		}),
		{ io: "input" },
	);
	const companyContext = [
		`Seller domain: ${icp.seller.domain}`,
		`Seller description: ${icp.seller.description}`,
		`Offer in scope: ${icp.icp.offer ?? ""}`,
		"Company requirements:",
		JSON.stringify(icp.icp.requirements),
	].join("\n");
	return {
		query: [plan.angle, plan.query, `Return up to ${count} distinct companies.`]
			.filter(Boolean)
			.join(" "),
		systemPrompt: `Today is ${today}. ${AGENT_INSTRUCTIONS}\n${companyContext}`,
		input: { exclusion: excludeDomains.map((website) => ({ website })) },
		effort: plan.agentEffort,
		outputSchema: z.json().parse(outputSchema),
	};
}

function toExaResult(company: ExaAgentCompany): ExaResult | null {
	const website = company.website;
	if (!website) return null;
	return {
		id: null,
		url: website,
		title: company.name ?? website,
		summary: null,
		company: CompanyRecordSchema.parse(company),
		person: null,
		...(company.linkedinUrl ? { linkedinUrl: company.linkedinUrl } : {}),
		evidence: company.evidence,
	};
}

/** Maps a completed agent run onto the same shape `search` returns, dropping any company the agent gave no website for. */
export function toExaSearchResult(
	requestId: string,
	companies: readonly ExaAgentCompany[],
): ExaSearchResult {
	const results = companies
		.map(toExaResult)
		.filter((result): result is ExaResult => result !== null);
	return { requestId, results };
}
