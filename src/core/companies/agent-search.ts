import { z } from "zod";
import { planConstraints } from "@/core/companies/candidates";
import type {
	ExaAgentCompany,
	ExaAgentRunRequest,
} from "@/core/providers/exa/agent";
import {
	ExaAgentCompanySchema,
	LINKEDIN_COMPANY_URL_PATTERN,
} from "@/core/providers/exa/agent";
import type { ExaResult, ExaSearchResult } from "@/core/providers/exa/search";
import { CompanyRecordSchema } from "@/core/providers/exa/search";
import type { IcpSeller, SearchPlan } from "@/core/synthesize";

const NOT_A_DIRECTORY_HOST =
	"^(?!(https?://)?(www\\.)?(linkedin|twitter|x|facebook|instagram|youtube|tiktok|medium|substack|github|crunchbase|pitchbook|tracxn|bloomberg|wellfound|angel|ycombinator|producthunt|glassdoor|indeed)\\.)";

const EVIDENCE_KINDS = [
	"company-announcement",
	"person-announcement",
	"news-article",
	"regulatory-filing",
	"vendor-case-study",
	"job-posting",
	"status-page",
	"other",
] as const;

const AgentCompanyRequestSchema = ExaAgentCompanySchema.extend({
	name: z.string(),
	website: z.string().regex(new RegExp(NOT_A_DIRECTORY_HOST)),
	linkedinUrl: z.string().regex(new RegExp(LINKEDIN_COMPANY_URL_PATTERN, "i")),
});

/**
 * What one company in the reply must carry. A profile that asks for a recent
 * event demands the signal and the page proving it; a profile that asks for
 * none leaves both out, so the agent never invents a signal to fill a field.
 */
function agentCompanySchema(plan: SearchPlan) {
	if (plan.recency === null) return AgentCompanyRequestSchema;
	return AgentCompanyRequestSchema.extend({
		signal: z.string(),
		evidenceUrl: z.string(),
		evidenceQuote: z.string(),
		evidencePublisher: z.string(),
		evidenceKind: z.enum(EVIDENCE_KINDS),
	});
}

function agentQuery(plan: SearchPlan, count: number): string {
	const constraints = planConstraints(plan);
	const parts = [
		plan.query,
		`Return exactly ${count} distinct companies.`,
		constraints,
		plan.recency,
	];
	return parts.filter((part) => part !== null && part !== "").join(" ");
}

/** Names who the run prospects for, so the agent stops returning that seller's own customers and its competitors. */
function sellerSentences(seller: IcpSeller | null): string[] {
	if (seller === null) return [];
	const sentences = [
		`You are prospecting for ${seller.domain}. Never return that company, and never`,
		"treat a page on its own site as proof of another company's signal.",
	];
	if (seller.customers.length > 0) {
		sentences.push(
			`These companies already buy from it, so never return them: ${seller.customers.join(", ")}.`,
		);
	}
	sentences.push(
		`Never return a company that competes with ${seller.domain}. ${seller.competitorTest}`,
	);
	return sentences;
}

/** Tells the agent what day it is, so a window in the query means something, and where the proof must come from. */
function agentSystemPrompt(today: string, seller: IcpSeller | null): string {
	return [
		`Today's date is ${today}.`,
		...sellerSentences(seller),
		"Give the company's own website domain in `website`, never a profile or",
		"directory page such as LinkedIn, Crunchbase, or GitHub. Put the page that",
		"proves the signal in `evidenceUrl`, never a careers index or a blog index,",
		"and the date printed on that page in `evidenceDate`, written as YYYY-MM-DD.",
		"Leave `evidenceDate` out when the page shows no date; never guess one.",
		"A page published outside the window the query gives for its signal",
		"disqualifies that company, so find a different company instead.",
		"The page in `evidenceUrl` must credibly belong to the company it names: its own",
		"site, or a service it plainly uses such as its applicant tracking system or its",
		"status page. A page about the company on an unrelated shared host, such as a free",
		"subdomain, proves nothing, so find the company's own page or drop the company.",
		"A LinkedIn post announcing the event is good evidence, because it carries a date",
		"and the company or the person it concerns wrote it. A linkedin.com/in member",
		"profile is never evidence, because it describes a person rather than recording an",
		"event that happened on a day.",
		"Put in `evidenceQuote` one sentence copied word for word from the evidence page,",
		"exactly as it appears there and never in your own wording, and in",
		"`evidencePublisher` the name that page gives for whoever publishes it, copied from",
		"the page. Write `the page does not say` in `evidencePublisher` when the page names",
		"nobody, rather than guessing a name from the address.",
		"Put in `evidenceKind` the sort of page the evidence is, choosing the one value that",
		"describes it. A page the company published about itself is a company-announcement;",
		"one a person published about their own move is a person-announcement; another",
		"vendor's page describing this company as its customer is a vendor-case-study.",
		"Put the industry the company operates in into `industry`, in two or three words,",
		"as the market it sells into rather than the product it makes.",
		"Give the company's own LinkedIn page in `linkedinUrl`. It is a",
		"linkedin.com/company address and never a personal profile. Every real company of",
		"this kind has one, so find the page rather than assembling an address from the",
		"company's name, and drop the company if no such page exists.",
		"Never repeat a company.",
	].join(" ");
}

/**
 * Turns one search plan and the number of companies wanted into an Exa agent
 * run request. The count reaches the agent in the query text only. It is not
 * the schema's floor: a run told to return thirty and finding twelve fails the
 * schema outright, and the vendor discards all twelve and reports "failed", so
 * a narrow profile loses everything it found. The plan's headcount band and
 * countries reach it as words, because the filter that follows rejects on them
 * and a candidate refused there was still paid for.
 */
export function buildAgentRunRequest(
	plan: SearchPlan,
	count: number,
	today: string,
	seller: IcpSeller | null,
): ExaAgentRunRequest {
	return {
		query: agentQuery(plan, count),
		systemPrompt: agentSystemPrompt(today, seller),
		effort: plan.agentEffort,
		dataSources: [{ provider: "fiber" }],
		outputSchema: z.json().parse(
			z.toJSONSchema(
				z.object({
					companies: z.array(agentCompanySchema(plan)).min(1),
				}),
				{ io: "input" },
			),
		),
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
		...(company.signal ? { signal: company.signal } : {}),
		...(company.evidenceQuote ? { evidenceQuote: company.evidenceQuote } : {}),
		...(company.evidencePublisher
			? { evidencePublisher: company.evidencePublisher }
			: {}),
		...(company.evidenceKind ? { evidenceKind: company.evidenceKind } : {}),
		...(company.evidenceUrl ? { evidenceUrl: company.evidenceUrl } : {}),
		...(company.evidenceDate ? { publishedDate: company.evidenceDate } : {}),
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
