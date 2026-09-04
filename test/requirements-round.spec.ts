import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import type {
	FindCompaniesDeps,
	FindCompaniesOptions,
} from "../src/core/companies";
import { anglesForRound, findCompanies } from "../src/core/companies";
import type { CompanyRow } from "../src/core/companies/gate";
import { gate } from "../src/core/companies/gate";
import type { Verdict } from "../src/core/companies/judge";
import { decideRows, provenRate } from "../src/core/companies/judge";
import type { ProvingHit } from "../src/core/companies/proof";
import { applyRecords } from "../src/core/companies/record";
import { CostLedger } from "../src/core/cost";
import type { ExaResult } from "../src/core/providers/exa/search";
import type { Requirement } from "../src/core/requirements";
import {
	hardPageRequirements,
	REQUIREMENTS_INSTRUCTIONS,
} from "../src/core/requirements";
import type { IcpDoc, SearchPlan } from "../src/core/synthesize";

const icp: IcpDoc = { description: "a profile" };

const recordRequirement: Requirement = {
	id: "r1",
	text: "the company is a bank",
	kind: "hard",
	proof: "record",
	windowDays: null,
};

const pageRequirement: Requirement = {
	id: "r2",
	text: "the company published an engineering page about its platform",
	kind: "hard",
	proof: "page",
	windowDays: 730,
};

const pageRequirement2: Requirement = {
	id: "r4",
	text: "the company published a security compliance page",
	kind: "hard",
	proof: "page",
	windowDays: 730,
};

const softRequirement: Requirement = {
	id: "r3",
	text: "the company posted a platform role recently",
	kind: "soft",
	proof: "page",
	windowDays: 30,
};

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		index: 0,
		statuses: [],
		soft: [],
		reason: "a reason",
		sameOrganizationAs: null,
		...overrides,
	};
}

function row(domain: string): CompanyRow {
	return {
		name: domain,
		domain,
		linkedinUrl: null,
		evidenceUrl: `https://${domain}/`,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: null,
		evidenceDate: null,
	};
}

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
	return {
		query: "banks",
		angle: "banking",
		pageQuery: null,
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

function exaResult(domain: string, workforce: number | null): ExaResult {
	return {
		id: null,
		url: `https://${domain}/`,
		title: domain,
		summary: null,
		person: null,
		company: {
			name: domain,
			description: "a company",
			industry: null,
			foundedYear: null,
			workforceTotal: workforce,
			city: null,
			country: "United Kingdom",
			revenueAnnual: null,
			fundingTotal: null,
		},
	};
}

function options(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return {
		icpId: "icp-1",
		organizationId: "org-1",
		env: testEnv,
		today: "2026-09-03",
		requirements: [recordRequirement],
		maxRounds: 1,
		...overrides,
	};
}

type RoundSpy = {
	deps: FindCompaniesDeps;
	order: string[];
	agentExclusions: Array<readonly string[]>;
	backfilled: Array<readonly string[]>;
	judged: CompanyRow[][];
};

type RoundScript = {
	route: "search" | "agent";
	requirements: readonly Requirement[];
	results: ExaResult[];
	hits?: Record<string, ProvingHit>;
	verdicts?: (rows: readonly CompanyRow[]) => Verdict[];
};

function spyingDeps(script: RoundScript): RoundSpy {
	const order: string[] = [];
	const agentExclusions: Array<readonly string[]> = [];
	const backfilled: Array<readonly string[]> = [];
	const judged: CompanyRow[][] = [];
	const deps: FindCompaniesDeps = {
		recentDomains: async () => [],
		synthesize: async () => ({
			route: script.route,
			plans: [
				plan({ source: script.route === "agent" ? "exa-agent" : "exa-search" }),
			],
			ledger: new CostLedger(),
		}),
		search: async () => {
			order.push("search");
			return { requestId: "req-1", results: script.results };
		},
		agentRound: async (_plans, excludeDomains) => {
			order.push("agent");
			agentExclusions.push(excludeDomains);
			return { requestId: "agent-1", results: script.results };
		},
		backfill: async (domains) => {
			backfilled.push(domains);
			return domains.map((domain) => ({ domain, record: null }));
		},
		prove: async (rows) => {
			order.push("prove");
			return rows.map((candidate, index) => ({
				index,
				hit: script.hits?.[candidate.domain ?? ""] ?? null,
			}));
		},
		gate,
		judge: async (_requirements, rows) => {
			order.push("judge");
			judged.push([...rows]);
			return {
				verdicts: script.verdicts
					? script.verdicts(rows)
					: rows.map((_row, index) =>
							verdict({
								index,
								statuses: hardPageRequirements(script.requirements).map(
									(req) => ({ id: req.id, status: "proven" }),
								),
							}),
						),
				ledger: new CostLedger(),
			};
		},
	};
	return { deps, order, agentExclusions, backfilled, judged };
}

describe("the route a round runs on comes from its requirements", () => {
	it("asks for one angle when nothing needs a page, and two per wanted company when something does", () => {
		expect(anglesForRound([recordRequirement], 20)).toBe(1);
		expect(anglesForRound([recordRequirement, pageRequirement], 3)).toBe(6);
	});

	it("never asks for more angles than one round may fan out to", () => {
		expect(anglesForRound([pageRequirement], 500)).toBe(
			config.companies.maxAnglesPerRound,
		);
	});

	it("sends a search round to the company index and never to the agent", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(icp, 1, options(), spy.deps);

		expect(spy.order).toContain("search");
		expect(spy.order).not.toContain("agent");
	});

	it("sends an agent round to the fan-out and backfills every record it named", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).toContain("agent");
		expect(spy.order).not.toContain("search");
		expect(spy.backfilled[0]).toEqual(["bank.com"]);
	});
});

describe("proving runs before the judge, never after it", () => {
	it("proves every candidate of a search round and then judges once", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
			hits: {
				"bank.com": {
					url: "https://bank.com/engineering",
					quote: "we run our own platform",
					publishedDate: "2026-01-01",
					text: "we run our own platform",
				},
			},
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).toEqual(["search", "prove", "judge"]);
	});

	it("hands the judge the proved page as the row's own evidence", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
			hits: {
				"bank.com": {
					url: "https://bank.com/engineering",
					quote: "we run our own platform",
					publishedDate: "2026-01-01",
					text: "we run our own platform",
				},
			},
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.judged[0]?.[0]?.evidenceUrl).toBe(
			"https://bank.com/engineering",
		);
		expect(spy.judged[0]?.[0]?.evidenceQuote).toBe("we run our own platform");
	});

	it("keeps the page it retrieved, so the content a decision rested on is stored", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
			hits: {
				"bank.com": {
					url: "https://bank.com/engineering",
					quote: "we run our own platform",
					publishedDate: "2026-01-01",
					text: "the whole page text",
				},
			},
		});

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(result.pages).toEqual([
			{
				domain: "bank.com",
				url: "https://bank.com/engineering",
				text: "the whole page text",
			},
		]);
	});
});

describe("every hard page requirement gets its own proof", () => {
	it("proves each hard page requirement separately, and gives the judge every page found", async () => {
		const proveCalls: string[] = [];
		let evidenceSeenByJudge:
			| ReadonlyMap<number, ReadonlyMap<string, { url: string; quote: string }>>
			| undefined;
		const spy = spyingDeps({
			route: "search",
			requirements: [pageRequirement, pageRequirement2],
			results: [exaResult("bank.com", 900)],
		});
		const deps: FindCompaniesDeps = {
			...spy.deps,
			prove: async (rows, requirement) => {
				proveCalls.push(requirement.id);
				const hit =
					requirement.id === pageRequirement.id
						? {
								url: "https://bank.com/engineering",
								quote: "we run our own platform",
								publishedDate: "2026-01-01",
								text: "we run our own platform",
							}
						: {
								url: "https://bank.com/security",
								quote: "SOC 2 type II certified",
								publishedDate: "2026-01-01",
								text: "SOC 2 type II certified",
							};
				return rows.map((_candidate, index) => ({ index, hit }));
			},
			judge: async (_requirements, rows, _env, evidenceByRow) => {
				evidenceSeenByJudge = evidenceByRow;
				return {
					verdicts: rows.map((_row, index) =>
						verdict({
							index,
							statuses: [
								{ id: pageRequirement.id, status: "proven" },
								{ id: pageRequirement2.id, status: "proven" },
							],
						}),
					),
					ledger: new CostLedger(),
				};
			},
		};

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [pageRequirement, pageRequirement2] }),
			deps,
		);

		expect(proveCalls.sort()).toEqual([
			pageRequirement.id,
			pageRequirement2.id,
		]);
		expect(result.pages.map((page) => page.url).sort()).toEqual([
			"https://bank.com/engineering",
			"https://bank.com/security",
		]);
		expect(evidenceSeenByJudge?.get(0)?.get(pageRequirement.id)?.quote).toBe(
			"we run our own platform",
		);
		expect(evidenceSeenByJudge?.get(0)?.get(pageRequirement2.id)?.quote).toBe(
			"SOC 2 type II certified",
		);
	});
});

describe("a search round's own proof reads the same as an agent round's evidence", () => {
	it("stamps an evidenceCheck on the row it proved, so a search round's evidence reads the same as an agent round's", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
			hits: {
				"bank.com": {
					url: "https://bank.com/engineering",
					quote: "we run our own platform",
					publishedDate: "2026-01-01",
					text: "we run our own platform",
				},
			},
		});

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(result.captures["bank.com"]?.result.evidenceCheck).toBe("found");
	});

	it("never proves on an agent round, because the agent already cited its page", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("bank.com", 900)],
		});

		await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			spy.deps,
		);

		expect(spy.order).not.toContain("prove");
	});
});

describe("the refusal policy differs by what can prove a requirement", () => {
	it("refuses a row that contradicts a hard requirement, whatever its proof", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r1", status: "contradicted" }] })],
			excluded: new Set(),
		});

		expect(decision.stored).toHaveLength(0);
		expect(decision.rejects[0]?.reason).toContain("contradicts r1");
	});

	it("keeps a row whose hard record requirement the record simply does not state", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r1", status: "unproven" }] })],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["a.com"]);
	});

	it("refuses a row whose hard page requirement no page proved", () => {
		const decision = decideRows({
			requirements: [pageRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r2", status: "unproven" }] })],
			excluded: new Set(),
		});

		expect(decision.stored).toHaveLength(0);
		expect(decision.rejects[0]?.reason).toContain("no page proved r2");
	});

	it("stores a row whose hard page requirement a cited page proved", () => {
		const decision = decideRows({
			requirements: [pageRequirement],
			rows: [row("a.com")],
			verdicts: [verdict({ statuses: [{ id: "r2", status: "proven" }] })],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["a.com"]);
	});

	it("never gates on a soft requirement, however it came back", () => {
		const decision = decideRows({
			requirements: [recordRequirement, softRequirement],
			rows: [row("a.com")],
			verdicts: [
				verdict({
					statuses: [
						{ id: "r1", status: "proven" },
						{ id: "r3", status: "contradicted" },
					],
				}),
			],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["a.com"]);
	});

	it("reports the share of candidates whose page requirements were proved, for the next round to read", () => {
		const verdicts = [
			verdict({ index: 0, statuses: [{ id: "r2", status: "proven" }] }),
			verdict({ index: 1, statuses: [{ id: "r2", status: "unproven" }] }),
		];

		expect(provenRate([pageRequirement], verdicts)).toBe("1 of 2");
		expect(provenRate([recordRequirement], verdicts)).toBeNull();
	});
});

describe("one organisation is stored once, under one brand", () => {
	it("drops a row the judge marked as the same organisation as another", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("home.barclays"), row("jobs.barclays")],
			verdicts: [
				verdict({ index: 0, statuses: [{ id: "r1", status: "proven" }] }),
				verdict({
					index: 1,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 0,
				}),
			],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual([
			"home.barclays",
		]);
		expect(decision.rejects[0]?.group).toBe(
			"one organisation under more than one brand",
		);
	});

	it("ignores a collapse onto itself or onto a row outside the batch", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("a.com"), row("b.com")],
			verdicts: [
				verdict({
					index: 0,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 0,
				}),
				verdict({
					index: 1,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 9,
				}),
			],
			excluded: new Set(),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual([
			"a.com",
			"b.com",
		]);
	});
});

describe("a company this account already holds never comes back", () => {
	it("drops an excluded domain and the brand the judge collapses onto it", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row("home.barclays"), row("jobs.barclays"), row("other.com")],
			verdicts: [
				verdict({ index: 0, statuses: [{ id: "r1", status: "proven" }] }),
				verdict({
					index: 1,
					statuses: [{ id: "r1", status: "proven" }],
					sameOrganizationAs: 0,
				}),
				verdict({ index: 2, statuses: [{ id: "r1", status: "proven" }] }),
			],
			excluded: new Set(["home.barclays"]),
		});

		expect(decision.stored.map((kept) => kept.domain)).toEqual(["other.com"]);
	});

	it("keeps an excluded company out of a stored search round", async () => {
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement],
			results: [exaResult("seen.com", 900), exaResult("fresh.com", 900)],
		});

		const result = await findCompanies(
			icp,
			2,
			options({ excludeDomains: ["seen.com"] }),
			spy.deps,
		);

		expect(result.companies.map((company) => company.domain)).toEqual([
			"fresh.com",
		]);
	});

	it("keeps an excluded company, and a brand of it, out of a stored agent round", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("jobs.barclays", 900), exaResult("fresh.com", 900)],
			verdicts: (rows) =>
				rows.map((candidate, index) =>
					verdict({
						index,
						statuses: [
							{ id: "r1", status: "proven" },
							{ id: "r2", status: "proven" },
						],
						sameOrganizationAs: candidate.domain === "jobs.barclays" ? 1 : null,
					}),
				),
		});

		const result = await findCompanies(
			icp,
			2,
			options({
				requirements: [recordRequirement, pageRequirement],
				excludeDomains: ["home.barclays"],
			}),
			spy.deps,
		);

		expect(result.companies.map((company) => company.domain)).not.toContain(
			"jobs.barclays",
		);
	});

	it("names the excluded companies in every fanned-out agent request", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("fresh.com", 900)],
		});

		await findCompanies(
			icp,
			1,
			options({
				requirements: [recordRequirement, pageRequirement],
				excludeDomains: ["seen.com"],
			}),
			spy.deps,
		);

		expect(spy.agentExclusions[0]).toContain("seen.com");
	});

	it("never spends a record lookup on an excluded domain", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("seen.com", 900), exaResult("fresh.com", 900)],
		});

		await findCompanies(
			icp,
			2,
			options({
				requirements: [recordRequirement, pageRequirement],
				excludeDomains: ["seen.com"],
			}),
			spy.deps,
		);

		expect(spy.backfilled[0]).toEqual(["fresh.com"]);
	});
});

describe("an agent-found company is bounded by the vendor's record, not its own claim", () => {
	it("prefers the vendor's figures and keeps the agent's where the vendor is silent", () => {
		const agentResult: ExaResult = {
			id: null,
			url: "https://saxo.com",
			title: "Saxo",
			summary: null,
			person: null,
			company: {
				name: "Saxo",
				description: "a bank",
				industry: "banking",
				foundedYear: null,
				workforceTotal: 2600,
				city: null,
				country: "Denmark",
				revenueAnnual: null,
				fundingTotal: null,
			},
		};
		const vendorResult: ExaResult = {
			...agentResult,
			company: {
				name: "Saxo Bank",
				description: "the vendor's description",
				industry: null,
				foundedYear: 1992,
				workforceTotal: 1403,
				city: "Copenhagen",
				country: "Denmark",
				revenueAnnual: null,
				fundingTotal: null,
			},
		};

		const applied = applyRecords(
			[agentResult],
			[{ domain: "saxo.com", record: vendorResult }],
		);

		expect(applied[0]?.company?.workforceTotal).toBe(1403);
		expect(applied[0]?.company?.description).toBe("the vendor's description");
		expect(applied[0]?.company?.industry).toBe("banking");
	});

	it("applies a record only to the domain it was asked for", () => {
		const applied = applyRecords(
			[exaResult("real.com", 17)],
			[
				{
					domain: "real.com",
					record: exaResult("real.com", 900),
				},
			],
		);

		expect(applied[0]?.company?.workforceTotal).toBe(900);
	});

	it("leaves a row alone when no lookup answered for its domain", () => {
		const applied = applyRecords([exaResult("real.com", 17)], []);

		expect(applied[0]?.company?.workforceTotal).toBe(17);
	});

	it("refuses an agent company the vendor's own record puts outside the bounds", async () => {
		const spy = spyingDeps({
			route: "agent",
			requirements: [recordRequirement, pageRequirement],
			results: [exaResult("small.com", 900)],
		});
		const boundedDeps: FindCompaniesDeps = {
			...spy.deps,
			synthesize: async () => ({
				route: "agent",
				plans: [plan({ source: "exa-agent", minWorkforce: 500 })],
				ledger: new CostLedger(),
			}),
			backfill: async (domains) =>
				domains.map((domain) => ({
					domain,
					record: exaResult(domain, 12),
				})),
		};

		const result = await findCompanies(
			icp,
			1,
			options({ requirements: [recordRequirement, pageRequirement] }),
			boundedDeps,
		);

		expect(result.companies).toHaveLength(0);
		expect(
			result.rejects.some((reject) => reject.reason.includes("headcount 12")),
		).toBe(true);
	});
});

describe("the round loop stays bounded", () => {
	it("never runs more rounds than it was given, even when every round falls short", async () => {
		let rounds = 0;
		const spy = spyingDeps({
			route: "search",
			requirements: [recordRequirement],
			results: [],
		});
		const countingDeps: FindCompaniesDeps = {
			...spy.deps,
			search: async () => {
				rounds += 1;
				return { requestId: `req-${rounds}`, results: [] };
			},
		};

		const result = await findCompanies(
			icp,
			10,
			options({ maxRounds: 3 }),
			countingDeps,
		);

		expect(rounds).toBe(3);
		expect(result.rounds).toBe(3);
		expect(result.status).toBe("empty");
	});
});

describe("the backfill reader reserves a page requirement for the population itself", () => {
	it("asks for `page` only where no description of shape could name the companies", () => {
		expect(REQUIREMENTS_INSTRUCTIONS).toContain(
			"`proof` is `page` only when the requirement is what defines the population",
		);
		expect(REQUIREMENTS_INSTRUCTIONS).toContain(
			"no description of lasting shape",
		);
	});

	it("sends a behaviour a record never states outright to `record`, not to `page`", () => {
		expect(REQUIREMENTS_INSTRUCTIONS).toContain(
			"including a behaviour no record states outright",
		);
		expect(REQUIREMENTS_INSTRUCTIONS).not.toContain(
			"structured company record can establish it",
		);
	});
});
