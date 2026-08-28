import type {
	CompanyEntity,
	ExaResult,
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa";
import type {
	ExaAgentCompany,
	ExaAgentRunRequest,
} from "@/core/providers/exa-agent";

const NOT_A_DIRECTORY_HOST =
	"^(?!(https?://)?(www\\.)?(linkedin|twitter|x|facebook|instagram|youtube|tiktok|medium|substack|github|crunchbase|pitchbook|tracxn|bloomberg|wellfound|angel|ycombinator|producthunt|glassdoor|indeed)\\.)";

const EXA_AGENT_COMPANY_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string" },
		website: {
			type: "string",
			pattern: NOT_A_DIRECTORY_HOST,
		},
		description: { type: "string" },
		foundedYear: { type: "number" },
		workforceTotal: { type: "number" },
		city: { type: "string" },
		country: { type: "string" },
		revenueAnnual: { type: "number" },
		fundingTotal: { type: "number" },
	},
	required: ["name", "website"],
};

function agentQuery(query: string, count: number): string {
	return `${query} Return exactly ${count} distinct companies.`;
}

/**
 * Turns one Exa search request and the number of companies wanted into an
 * Exa agent run request. The count reaches the agent twice: in the query
 * text and as `minItems` on the schema, so the run does not stop early with
 * too few rows.
 */
export function buildAgentRunRequest(
	req: ExaSearchRequest,
	count: number,
	effort: ExaAgentRunRequest["effort"],
): ExaAgentRunRequest {
	return {
		query: agentQuery(req.query, count),
		systemPrompt:
			"Give the company's own website domain, never a profile or directory page such as LinkedIn, Crunchbase, or GitHub. Never repeat a company.",
		effort,
		dataSources: [{ provider: "fiber" }],
		outputSchema: {
			type: "object",
			properties: {
				companies: {
					type: "array",
					minItems: count,
					items: EXA_AGENT_COMPANY_SCHEMA,
				},
			},
			required: ["companies"],
		},
	};
}

function toCompanyEntity(company: ExaAgentCompany): CompanyEntity {
	return {
		name: company.name ?? null,
		description: company.description ?? null,
		foundedYear: company.foundedYear ?? null,
		workforceTotal: company.workforceTotal ?? null,
		city: company.city ?? null,
		country: company.country ?? null,
		revenueAnnual: company.revenueAnnual ?? null,
		fundingTotal: company.fundingTotal ?? null,
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
		company: toCompanyEntity(company),
		person: null,
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
