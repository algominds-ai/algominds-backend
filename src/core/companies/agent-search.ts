import type { NumericLimit } from "@/core/companies/candidates";
import { NUMERIC_LIMITS } from "@/core/companies/candidates";
import type {
	ExaAgentCompany,
	ExaAgentRunRequest,
} from "@/core/providers/exa/agent";
import type {
	CompanyEntity,
	ExaResult,
	ExaSearchResult,
} from "@/core/providers/exa/search";
import type { SearchPlan } from "@/core/synthesize";

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

function limitRule(limit: NumericLimit, plan: SearchPlan): string | null {
	const floor = limit.floor(plan);
	const ceiling = limit.ceiling(plan);
	if (floor !== null && ceiling !== null) {
		return `Every company must have a ${limit.label} between ${floor} and ${ceiling}.`;
	}
	if (ceiling !== null) {
		return `Every company must have a ${limit.label} of at most ${ceiling}.`;
	}
	if (floor !== null) {
		return `Every company must have a ${limit.label} of at least ${floor}.`;
	}
	return null;
}

/** The plan's bounds as sentences, because an agent reads instructions where a search index cannot. */
function planConstraints(plan: SearchPlan): string {
	const rules = NUMERIC_LIMITS.map((limit) => limitRule(limit, plan)).filter(
		(rule): rule is string => rule !== null,
	);
	if (plan.countries.length > 0) {
		rules.push(
			`Every company must be based in ${plan.countries.join(" or ")}.`,
		);
	}
	return rules.join(" ");
}

function agentQuery(plan: SearchPlan, count: number): string {
	const constraints = planConstraints(plan);
	return `${plan.query} Return exactly ${count} distinct companies.${constraints ? ` ${constraints}` : ""}`;
}

/**
 * Turns one search plan and the number of companies wanted into an Exa agent
 * run request. The count reaches the agent twice, in the query text and as
 * `minItems`, so the run does not stop early with too few rows. The plan's
 * headcount band and countries reach it as words, because the filter that
 * follows rejects on them and a candidate refused there was still paid for.
 */
export function buildAgentRunRequest(
	plan: SearchPlan,
	count: number,
	effort: ExaAgentRunRequest["effort"],
): ExaAgentRunRequest {
	return {
		query: agentQuery(plan, count),
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
