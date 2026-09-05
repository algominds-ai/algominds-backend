import { describe, expect, it } from "vitest";
import { toExaSearchResult } from "../../src/core/companies/agent-search";
import { filterEntities } from "../../src/core/companies/candidates";
import type { ExaAgentCompany } from "../../src/core/providers/exa/agent";
import { ExaAgentCompanySchema } from "../../src/core/providers/exa/agent";
import type { SearchPlan } from "../../src/core/synthesize";

function planFor(
	query: string,
	overrides: Partial<SearchPlan> = {},
): SearchPlan {
	return {
		query,
		angle: "angle-1",
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
		source: "exa-search",
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
		...overrides,
	};
}

function agentCompany(
	overrides: Partial<ExaAgentCompany> = {},
): ExaAgentCompany {
	return {
		name: "Kastle",
		website: "https://kastle.com",
		linkedinUrl: null,
		description: null,
		industry: null,
		foundedYear: null,
		workforceTotal: null,
		city: null,
		country: null,
		revenueAnnual: null,
		fundingTotal: null,
		signal: null,
		evidenceUrl: null,
		evidenceDate: null,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		...overrides,
	};
}

describe("an agent company becomes a row whose domain is the company, not the evidence host", () => {
	it("maps a completed run's companies onto the same shape `search` returns, nulling fields the agent gave nothing for", () => {
		const { results } = toExaSearchResult("run-completed", [
			agentCompany({ industry: null }),
		]);

		expect(results).toHaveLength(1);
		expect(results[0]?.url).toBe("https://kastle.com");
		expect(results[0]?.company).toEqual({
			name: "Kastle",
			description: null,
			industry: null,
			foundedYear: null,
			workforceTotal: null,
			city: null,
			country: null,
			revenueAnnual: null,
			fundingTotal: null,
		});
	});

	it("drops a company the agent gave no website for", () => {
		const { results } = toExaSearchResult("run-completed", [
			agentCompany({ website: null }),
		]);

		expect(results).toHaveLength(0);
	});

	it("keeps the website as the result url and the proving page as the evidence url", () => {
		const { results } = toExaSearchResult("req-1", [
			agentCompany({
				signal: "posted a Head of Sales role",
				evidenceUrl: "https://jobs.ashbyhq.com/kastle/735bed91",
				evidenceDate: "2026-08-12",
			}),
		]);

		expect(results[0]?.url).toBe("https://kastle.com");
		expect(results[0]?.evidenceUrl).toBe(
			"https://jobs.ashbyhq.com/kastle/735bed91",
		);
		expect(results[0]?.publishedDate).toBe("2026-08-12");
		expect(results[0]?.signal).toBe("posted a Head of Sales role");
	});
});

describe("a company LinkedIn page reaches the row, a personal profile does not", () => {
	function rowForLinkedin(linkedinUrl: string | null) {
		const { results } = toExaSearchResult("req-1", [
			agentCompany({ linkedinUrl }),
		]);
		return filterEntities(results, planFor("security companies"), "2026-08-30")
			.rows[0];
	}

	it("keeps a linkedin.com/company address, and drops a personal profile the agent mistook for the company", () => {
		expect(
			rowForLinkedin("https://linkedin.com/company/kastle")?.linkedinUrl,
		).toBe("https://linkedin.com/company/kastle");

		const parsed = ExaAgentCompanySchema.parse(
			agentCompany({ linkedinUrl: "https://linkedin.com/in/some-person" }),
		);
		expect(parsed.linkedinUrl).toBeNull();
		expect(rowForLinkedin(parsed.linkedinUrl)?.linkedinUrl).toBeNull();
	});
});

describe("the agent's evidence reaches the row the judge reads", () => {
	function rowFor(signal: string | null, evidenceUrl: string | null) {
		const { results } = toExaSearchResult("req-1", [
			agentCompany({
				description: "a security company",
				workforceTotal: 470,
				country: "United States",
				signal,
				evidenceUrl,
				evidenceDate: "2026-08-12",
			}),
		]);
		return filterEntities(results, planFor("security companies"), "2026-08-30")
			.rows[0];
	}

	it("cites the proving page, keeps the company as the domain, and shows the judge the signal", () => {
		const row = rowFor(
			"posted a Head of Sales role on 2026-08-12",
			"https://jobs.ashbyhq.com/kastle/735bed91",
		);

		expect(row?.domain).toBe("kastle.com");
		expect(row?.evidenceUrl).toBe("https://jobs.ashbyhq.com/kastle/735bed91");
		expect(row?.signal).toBe("posted a Head of Sales role on 2026-08-12");
		expect(row?.description).toContain("headcount 470");
	});

	it("falls back to the company's own site when a source proves nothing", () => {
		const row = rowFor(null, null);

		expect(row?.evidenceUrl).toBe("https://kastle.com");
		expect(row?.signal).toBeNull();
	});

	it("carries the quote and the publisher onto the row and the capture", () => {
		const { results } = toExaSearchResult("req-1", [
			agentCompany({
				signal: "posted a Head of Sales role",
				evidenceUrl: "https://jobs.ashbyhq.com/kastle/735bed91",
				evidenceDate: "2026-08-12",
				evidenceQuote: "Kastle is hiring a Head of Sales in San Francisco.",
				evidencePublisher: "Kastle Careers",
			}),
		]);
		const outcome = filterEntities(
			results,
			planFor("security companies"),
			"2026-08-30",
		);

		expect(outcome.rows[0]?.evidenceQuote).toBe(
			"Kastle is hiring a Head of Sales in San Francisco.",
		);
		expect(outcome.rows[0]?.evidencePublisher).toBe("Kastle Careers");
		expect(outcome.captures["kastle.com"]?.result.publisher).toBe(
			"Kastle Careers",
		);
	});

	it("carries the evidence kind onto the row the search returns", () => {
		const result = toExaSearchResult("run-kind", [
			agentCompany({
				signal: "posted a platform engineering role",
				evidenceUrl: "https://kadmos.io/careers/1",
				evidenceDate: "2026-08-12",
				evidenceKind: "job-posting",
			}),
		]);

		expect(result.results[0]?.evidenceKind).toBe("job-posting");
	});

	it("carries the industry through, and describes the company with it", () => {
		const { results } = toExaSearchResult("req-1", [
			agentCompany({
				name: "Zealhire",
				website: "https://zealhire.com",
				industry: "IT staffing and recruitment",
				workforceTotal: 40,
				country: "United States",
				signal: "posted for a India based recruiter on US shift",
				evidenceUrl: "https://linkedin.com/posts/zealhire_hiring",
				evidenceDate: "2026-08-03",
			}),
		]);
		const outcome = filterEntities(
			results,
			planFor("staffing agencies"),
			"2026-08-30",
		);

		expect(outcome.rows[0]?.industry).toBe("IT staffing and recruitment");
		expect(outcome.rows[0]?.description).toContain(
			"IT staffing and recruitment",
		);
	});
});

describe("evidence outside the window the profile asks for is refused in code", () => {
	function outcomeFor(evidenceDate: string | null, recencyDays: number | null) {
		const { results } = toExaSearchResult("req-1", [
			agentCompany({
				name: "Kadmos",
				website: "https://kadmos.io",
				signal: "granted an electronic money institution licence",
				evidenceUrl: "https://kadmos.io/press-releases/emi",
				evidenceDate,
				evidenceQuote:
					"Kadmos granted FCA Electronic Money Institution authorisation",
				evidencePublisher: "Kadmos",
			}),
		]);
		return filterEntities(
			results,
			planFor("payment providers", { recencyDays }),
			"2026-08-30",
		);
	}

	it("refuses a page four days past the window, which the judge read as about a year", () => {
		const outcome = outcomeFor("2025-08-26", 365);

		expect(outcome.rows).toHaveLength(0);
		expect(outcome.rejects[0]?.reason).toContain("369 days old");
		expect(outcome.rejects[0]?.stage).toBe("filter");
	});

	it("keeps a page inside the window", () => {
		expect(outcomeFor("2026-08-19", 365).rows).toHaveLength(1);
	});

	it("sends an undated page to the judge rather than refusing it outright", () => {
		const outcome = outcomeFor(null, 90);

		expect(outcome.rows).toHaveLength(1);
		expect(outcome.rejects).toHaveLength(0);
	});

	it("keeps an undated page when the profile asks for nothing recent", () => {
		expect(outcomeFor(null, null).rows).toHaveLength(1);
	});

	it("refuses a page whose date the code cannot read at all", () => {
		const outcome = outcomeFor("not-a-date", 30);

		expect(outcome.rows).toHaveLength(0);
		expect(outcome.rejects[0]?.reason).toBe("the evidence date is not a date");
	});
});
