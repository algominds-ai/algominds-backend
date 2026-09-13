import { describe, expect, it } from "vitest";
import { z } from "zod";
import recorded from "../../exports/company-cycle-2026-09-06/form3-agent-minimal-refine-1788681482177-result.json";
import { toExaSearchResult } from "../../src/core/companies/agent-search";
import { filterEntities } from "../../src/core/companies/candidates";
import type { ExaAgentCompany } from "../../src/core/providers/exa/agent";
import { ExaAgentCompanySchema } from "../../src/core/providers/exa/agent";
import type { SearchPlan } from "../../src/core/synthesize";

function plan(): SearchPlan {
	return {
		query: "security companies",
		angle: "platform",
		source: "exa-agent",
		agentEffort: "low",
		userLocation: null,
		countries: [],
		minWorkforce: null,
		maxWorkforce: null,
		minFoundedYear: null,
		maxFoundedYear: null,
		minRevenueAnnual: null,
		maxRevenueAnnual: null,
		minFundingTotal: null,
		maxFundingTotal: null,
	};
}

function company(overrides: Partial<ExaAgentCompany> = {}): ExaAgentCompany {
	return {
		name: "Kastle",
		website: "https://kastle.com",
		linkedinUrl: "https://linkedin.com/company/kastle",
		description: "a security company",
		industry: "security",
		foundedYear: null,
		workforceTotal: 470,
		city: null,
		country: "United States",
		revenueAnnual: null,
		fundingTotal: null,
		evidence: [
			{
				conditionId: "r1.a1.c1",
				sourceUrl: "https://kastle.com/careers/platform",
				quote: "Kastle is hiring a Head of Platform.",
				eventDate: null,
				publishedDate: "2026-08-12",
			},
		],
		...overrides,
	};
}

describe("Exa agent evidence transport", () => {
	it("accepts the recorded Form3 reply's source citations and keeps their condition paths", () => {
		const raw = z
			.object({
				response: z.object({
					output: z.object({
						structured: z.object({ companies: z.array(z.unknown()) }),
					}),
				}),
			})
			.parse(recorded);
		const first = raw.response.output.structured.companies[0];
		const parsed = ExaAgentCompanySchema.parse(first);
		expect(parsed.name).toBe("Skyscanner");
		expect(parsed.evidence.filter((entry) => entry.sourceUrl)).toHaveLength(8);
		expect(parsed.evidence[0]?.conditionId).toBe("r1.a1.c1");
		expect(parsed.evidence[0]?.sourceUrl).toContain("opentelemetry.io");
	});

	it("maps identity and condition citations without treating a quote as page text", () => {
		const { results } = toExaSearchResult("run-1", [company()]);
		const result = results[0];
		expect(result?.url).toBe("https://kastle.com");
		expect(result?.linkedinUrl).toBe("https://linkedin.com/company/kastle");
		expect(result?.evidence).toEqual(company().evidence);
		expect(result?.evidence?.[0]?.quote).toBe(
			"Kastle is hiring a Head of Platform.",
		);
		expect(filterEntities(results, plan(), "2026-08-30").rows[0]?.domain).toBe(
			"kastle.com",
		);
	});

	it("rejects personal LinkedIn URLs and drops missing websites", () => {
		const parsed = ExaAgentCompanySchema.parse(
			company({ linkedinUrl: "https://linkedin.com/in/a-person" }),
		);
		expect(parsed.linkedinUrl).toBeNull();
		expect(
			toExaSearchResult("run-1", [company({ website: null })]).results,
		).toEqual([]);
	});
});
