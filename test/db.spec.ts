import { env as testEnv } from "cloudflare:workers";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { IndexColumn, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { MAX_EXCLUDED_DOMAINS } from "../src/core/companies/candidates";
import { organization } from "../src/core/db/auth-schema";
import type { DbMode } from "../src/core/db/client";
import { db, withConnection } from "../src/core/db/client";
import { organizationForSlug } from "../src/core/db/organizations";
import type {
	CompanyCreateConnection,
	CompanyInsertConnection,
	CompanyRunConnection,
	DbFactory,
	DeleteTransaction,
	DomainsConnection,
	EvidenceAppendConnection,
	EvidenceReadConnection,
	IcpConnection,
	IcpInsertConnection,
	Organization,
	OrganizationConnection,
	OrganizationSpendConnection,
	RoundInsertConnection,
	RunCompanyInsertConnection,
	RunCompanyLookupConnection,
	RunLookupConnection,
	RunOpenConnection,
	RunUpdateConnection,
	TransactableConnection,
} from "../src/core/db/queries";
import {
	appendEvidence,
	closeErroredRun,
	closeRun,
	companiesForRun,
	createCompanyRow,
	createIcp,
	cutoffDate,
	deletePerson,
	latestEvidence,
	loadIcp,
	openRun,
	organizationSpendToday,
	recentDomains,
	recordRunSpend,
	saveCompanies,
	saveRound,
	saveRunCompanies,
	startOfUtcDay,
	upsertPeople,
} from "../src/core/db/queries";
import type {
	CompanyPageConnection,
	CompanyPageRow,
	PersonPageConnection,
	RunCompanyPageRow,
} from "../src/core/db/run-pages";
import { companiesPage, peoplePage } from "../src/core/db/run-pages";
import type {
	Company,
	Evidence,
	Icp,
	NewCompany,
	NewEvidence,
	NewIcp,
	NewRound,
	NewRun,
	Person,
	Run,
} from "../src/core/db/schema";
import {
	company,
	evidence,
	icp as icpTable,
	normalizeDomain,
	person,
	run,
	runCompany,
} from "../src/core/db/schema";
import { rawEvidenceRow } from "../src/core/people/rows";
import type { IcpSeller } from "../src/core/synthesize";
import {
	deleteOrganizations as cleanupOrganizations,
	seedOrganization,
} from "./support/db";
import { fakeDbEnv as fakeEnv } from "./support/env";
import { companyRow, personRow, runCompanyRow, runRow } from "./support/rows";

describe("normalizeDomain", () => {
	const cases: Array<[string, string]> = [
		["https://WWW.Acme.com/careers", "acme.com"],
		["acme.com", "acme.com"],
		["ACME.COM", "acme.com"],
		["http://acme.com", "acme.com"],
		["www.acme.com", "acme.com"],
		["https://acme.com:8443/path?query=1", "acme.com"],
		["Acme.com/", "acme.com"],
		["HTTPS://WWW.ACME.COM", "acme.com"],
		["shop.acme.co.uk", "acme.co.uk"],
		["branches.lloydsbank.com", "lloydsbank.com"],
	];

	for (const [input, expected] of cases) {
		it(`normalizes ${input} to ${expected}`, () => {
			expect(normalizeDomain(input)).toBe(expected);
		});
	}

	it("collapses any subdomain to its registrable domain, not only www", () => {
		expect(normalizeDomain("shop.acme.com")).toBe("acme.com");
	});

	it("keeps a brand top-level domain as-is, because the whole host is already registrable", () => {
		expect(normalizeDomain("jobs.barclays")).toBe("jobs.barclays");
	});

	it("keeps a host with no public-suffix match as-is", () => {
		expect(normalizeDomain("localhost")).toBe("localhost");
		expect(normalizeDomain("127.0.0.1")).toBe("127.0.0.1");
	});
});

describe("cutoffDate", () => {
	it("puts a company found 91 days ago outside a 90-day window", () => {
		const now = new Date("2026-08-27T00:00:00.000Z");
		const cutoff = cutoffDate(90, now);
		const foundAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
		expect(foundAt.getTime() < cutoff.getTime()).toBe(true);
	});

	it("keeps a company found 89 days ago inside a 90-day window", () => {
		const now = new Date("2026-08-27T00:00:00.000Z");
		const cutoff = cutoffDate(90, now);
		const foundAt = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);
		expect(foundAt.getTime() >= cutoff.getTime()).toBe(true);
	});
});

describe("db", () => {
	it("wires cached and direct modes to different Hyperdrive bindings", () => {
		const env = fakeEnv(
			"postgres://user:pass@cached-host:5432/algo_cached",
			"postgres://user:pass@direct-host:5432/algo_direct",
		);
		const cachedOptions = db(env, "cached").$client.options;
		const directOptions = db(env, "direct").$client.options;

		expect(cachedOptions.host).toEqual(["cached-host"]);
		expect(directOptions.host).toEqual(["direct-host"]);
		expect(cachedOptions.database).toBe("algo_cached");
		expect(directOptions.database).toBe("algo_direct");
	});
});

describe("recentDomains", () => {
	it("reads through the direct binding, never cached", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [{ domain: "acme.com" }, { domain: "beta.com" }];
		let recordedMode: DbMode | undefined;

		const buildDb: DbFactory<DomainsConnection> = (_env, mode) => {
			recordedMode = mode;
			return {
				select: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => ({
								limit: () => Promise.resolve(rows),
							}),
						}),
					}),
				}),
			};
		};

		const result = await recentDomains(env, "org-1", 60, buildDb);

		expect(recordedMode).toBe("direct");
		expect(result).toEqual(["acme.com", "beta.com"]);
	});

	it("caps the exclusion list at the search contract's limit, most recent first", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [{ domain: "acme.com" }, { domain: "beta.com" }];
		let recordedOrder: unknown;
		let recordedLimit: number | undefined;

		const buildDb: DbFactory<DomainsConnection> = () => ({
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: (order: SQL) => {
							recordedOrder = order;
							return {
								limit: (count: number) => {
									recordedLimit = count;
									return Promise.resolve(rows);
								},
							};
						},
					}),
				}),
			}),
		});

		await recentDomains(env, "org-1", 60, buildDb);

		expect(recordedOrder).toEqual(desc(company.foundAt));
		expect(recordedLimit).toBe(MAX_EXCLUDED_DOMAINS);
	});

	it("excludes every company the account found in the window, across its profiles", async () => {
		const fixture = await seedRecentDomainsFixture();
		try {
			const result = await recentDomains(
				testEnv,
				fixture.org.id,
				config.companies.seenDomainsWindowDays,
			);

			expect(result.sort()).toEqual([fixture.domainA, fixture.domainB].sort());
		} finally {
			await cleanupRecentDomainsFixture(fixture);
		}
	});
});

type RecentDomainsFixture = {
	org: Organization;
	otherOrg: Organization;
	icpA: Icp;
	icpB: Icp;
	runIdA: string;
	runIdB: string;
	otherRunId: string;
	domainA: string;
	domainB: string;
	saved: Company[];
};

type RecentDomainsOrgs = {
	org: Organization;
	otherOrg: Organization;
	icpA: Icp;
	icpB: Icp;
	runIdA: string;
	runIdB: string;
	otherRunId: string;
};

async function seedRecentDomainsOrgs(): Promise<RecentDomainsOrgs> {
	const org = await seedOrganization("recent-domains-account");
	const otherOrg = await seedOrganization("recent-domains-other");
	const icpA = await createIcp(testEnv, {
		description: "seed icp A for recentDomains",
		domain: `db-spec-recent-domains-a-${crypto.randomUUID()}.internal`,
		organizationId: org.id,
	});
	const icpB = await createIcp(testEnv, {
		description: "seed icp B for recentDomains",
		domain: `db-spec-recent-domains-b-${crypto.randomUUID()}.internal`,
		organizationId: org.id,
	});
	const runIdA = `companies_recent-domains-a-${crypto.randomUUID()}`;
	const runIdB = `companies_recent-domains-b-${crypto.randomUUID()}`;
	const otherRunId = `companies_recent-domains-other-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runIdA,
		organizationId: org.id,
		icpId: icpA.id,
		capability: "companies",
		status: "complete",
	});
	await openRun(testEnv, {
		id: runIdB,
		organizationId: org.id,
		icpId: icpB.id,
		capability: "companies",
		status: "complete",
	});
	await openRun(testEnv, {
		id: otherRunId,
		organizationId: otherOrg.id,
		icpId: null,
		capability: "companies",
		status: "complete",
	});
	return { org, otherOrg, icpA, icpB, runIdA, runIdB, otherRunId };
}

async function seedRecentDomainsFixture(): Promise<RecentDomainsFixture> {
	const orgs = await seedRecentDomainsOrgs();
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;
	const recentDate = new Date(now - 10 * dayMs);
	const staleDate = new Date(
		now - (config.companies.seenDomainsWindowDays + 1) * dayMs,
	);
	const domainA = `recent-domains-a-${crypto.randomUUID()}.com`;
	const domainB = `recent-domains-b-${crypto.randomUUID()}.com`;
	const staleDomain = `recent-domains-stale-${crypto.randomUUID()}.com`;
	const otherDomain = `recent-domains-other-${crypto.randomUUID()}.com`;

	const saved = await saveCompanies(testEnv, [
		{
			icpId: orgs.icpA.id,
			organizationId: orgs.org.id,
			domain: domainA,
			name: "Recent A",
			runId: orgs.runIdA,
			foundAt: recentDate,
		},
		{
			icpId: orgs.icpB.id,
			organizationId: orgs.org.id,
			domain: domainB,
			name: "Recent B",
			runId: orgs.runIdB,
			foundAt: recentDate,
		},
		{
			icpId: orgs.icpA.id,
			organizationId: orgs.org.id,
			domain: staleDomain,
			name: "Stale",
			runId: orgs.runIdA,
			foundAt: staleDate,
		},
		{
			icpId: null,
			organizationId: orgs.otherOrg.id,
			domain: otherDomain,
			name: "Other org",
			runId: orgs.otherRunId,
			foundAt: recentDate,
		},
	]);

	return { ...orgs, domainA, domainB, saved };
}

async function cleanupRecentDomainsFixture(
	fixture: RecentDomainsFixture,
): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection.delete(company).where(
			inArray(
				company.id,
				fixture.saved.map((row) => row.id),
			),
		);
		await connection
			.delete(run)
			.where(
				inArray(run.id, [fixture.runIdA, fixture.runIdB, fixture.otherRunId]),
			);
		await connection
			.delete(icpTable)
			.where(inArray(icpTable.id, [fixture.icpA.id, fixture.icpB.id]));
	});
	await cleanupOrganizations([fixture.org.id, fixture.otherOrg.id]);
}

describe("loadIcp", () => {
	it("reads through the cached binding, not direct", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const row: Icp = {
			id: "icp-1",
			organizationId: "org-1",
			domain: "acme.com",
			doc: null,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		let recordedMode: DbMode | undefined;

		const buildDb: DbFactory<IcpConnection> = (_env, mode) => {
			recordedMode = mode;
			return {
				select: () => ({
					from: () => ({
						where: () => ({
							limit: () => Promise.resolve([row]),
						}),
					}),
				}),
			};
		};

		const result = await loadIcp(env, "icp-1", buildDb);

		expect(recordedMode).toBe("cached");
		expect(result).toEqual(row);
	});
});

describe("createIcp", () => {
	const env = fakeEnv("postgres://cached", "postgres://direct");
	const storedRow: Icp = {
		id: "icp-1",
		organizationId: "org-1",
		domain: "acme.com",
		doc: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};

	it("writes the whole document, description and seller block alike", async () => {
		const seller: IcpSeller = {
			domain: "acme.com",
			customers: ["Acme Corp"],
			competitorTest: "A competitor sells the same tooling to other vendors.",
		};
		let insertedDoc: unknown;
		const buildDb: DbFactory<IcpInsertConnection> = () => ({
			insert: () => ({
				values: (row: NewIcp | NewIcp[]) => {
					insertedDoc = Array.isArray(row) ? row[0]?.doc : row.doc;
					return { returning: () => Promise.resolve([storedRow]) };
				},
			}),
		});

		await createIcp(
			env,
			{
				domain: "acme.com",
				organizationId: "org-1",
				description: "an ideal customer profile",
				seller,
			},
			buildDb,
		);

		expect(insertedDoc).toEqual({
			description: "an ideal customer profile",
			seller,
			buyer: null,
			requirements: null,
		});
	});

	it("writes a null seller when the caller gives none, matching the prompt-only onboarding path", async () => {
		let insertedDoc: unknown;
		const buildDb: DbFactory<IcpInsertConnection> = () => ({
			insert: () => ({
				values: (row: NewIcp | NewIcp[]) => {
					insertedDoc = Array.isArray(row) ? row[0]?.doc : row.doc;
					return { returning: () => Promise.resolve([storedRow]) };
				},
			}),
		});

		await createIcp(
			env,
			{
				domain: "acme.com",
				organizationId: "org-1",
				description: "an ideal customer profile",
			},
			buildDb,
		);

		expect(insertedDoc).toEqual({
			description: "an ideal customer profile",
			seller: null,
			buyer: null,
			requirements: null,
		});
	});
});

describe("saveCompanies", () => {
	const env = fakeEnv("postgres://cached", "postgres://direct");

	it("normalizes a domain before it reaches the insert", async () => {
		const received: NewCompany[] = [];
		const buildDb: DbFactory<CompanyInsertConnection> = () => ({
			insert: () => ({
				values: (rows: NewCompany | NewCompany[]) => {
					received.push(...(Array.isArray(rows) ? rows : [rows]));
					return {
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([]),
						}),
					};
				},
			}),
		});

		await saveCompanies(
			env,
			[
				{
					icpId: "icp-1",
					organizationId: "org-1",
					domain: "https://WWW.Acme.com/careers",
					name: "Acme",
					runId: "run-1",
				},
			],
			buildDb,
		);

		expect(received[0]?.domain).toBe("acme.com");
	});

	it("targets the (icp_id, domain) unique pair so a repeat insert is a no-op", async () => {
		let conflictTarget: IndexColumn | IndexColumn[] | undefined;
		const buildDb: DbFactory<CompanyInsertConnection> = () => ({
			insert: () => ({
				values: () => ({
					onConflictDoNothing: (config) => {
						conflictTarget = config?.target;
						return { returning: () => Promise.resolve([]) };
					},
				}),
			}),
		});

		await saveCompanies(
			env,
			[
				{
					icpId: "icp-1",
					organizationId: "org-1",
					domain: "acme.com",
					name: "Acme",
					runId: "run-1",
				},
			],
			buildDb,
		);

		expect(conflictTarget).toEqual([company.icpId, company.domain]);
	});

	it("returns early without building a connection for an empty batch", async () => {
		let called = false;
		const buildDb: DbFactory<CompanyInsertConnection> = () => {
			called = true;
			throw new Error("must not be called for an empty batch");
		};

		const result = await saveCompanies(env, [], buildDb);

		expect(result).toEqual([]);
		expect(called).toBe(false);
	});
});

describe("appendEvidence", () => {
	it("only ever inserts, never resolves a conflict", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows: NewEvidence[] = [
			{
				subjectType: "person",
				subjectId: "person-1",
				kind: "email",
				value: "a@acme.com",
				source: "apollo",
			},
		];
		const storedRow: Evidence = {
			id: "evidence-1",
			subjectType: "person",
			subjectId: "person-1",
			kind: "email",
			value: "a@acme.com",
			source: "apollo",
			confidence: null,
			status: null,
			seenAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const buildDb: DbFactory<EvidenceAppendConnection> = () => ({
			insert: () => ({
				values: (values: NewEvidence | NewEvidence[]) => {
					expect(values).toEqual(rows);
					return { returning: () => Promise.resolve([storedRow]) };
				},
			}),
		});

		const result = await appendEvidence(env, rows, buildDb);

		expect(result).toEqual([storedRow]);
	});
});

describe("latestEvidence", () => {
	it("orders by seen_at descending and takes the newest row", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let orderedBy = false;
		let recordedMode: DbMode | undefined;
		const row: Evidence = {
			id: "evidence-1",
			subjectType: "person",
			subjectId: "person-1",
			kind: "email",
			value: "a@acme.com",
			source: "apollo",
			confidence: null,
			status: null,
			seenAt: new Date("2026-01-01T00:00:00.000Z"),
		};

		const buildDb: DbFactory<EvidenceReadConnection> = (_env, mode) => {
			recordedMode = mode;
			return {
				select: () => ({
					from: () => ({
						where: () => ({
							orderBy: () => {
								orderedBy = true;
								return { limit: () => Promise.resolve([row]) };
							},
						}),
					}),
				}),
			};
		};

		const result = await latestEvidence(env, "person-1", "email", buildDb);

		expect(recordedMode).toBe("cached");
		expect(orderedBy).toBe(true);
		expect(result).toEqual(row);
	});
});

describe("deletePerson", () => {
	it("deletes every evidence row for the subject, then the person row, in one transaction", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const deletedTables: PgTable[] = [];
		const wherePredicates: (SQL | undefined)[] = [];

		const fakeTx: DeleteTransaction = {
			delete: (table) => {
				deletedTables.push(table);
				return {
					where: (predicate) => {
						wherePredicates.push(predicate);
						return Promise.resolve([]);
					},
				};
			},
		};

		const buildDb: DbFactory<TransactableConnection> = () => ({
			transaction: (fn) => fn(fakeTx),
		});

		await deletePerson(env, "person-1", buildDb);

		expect(deletedTables).toEqual([evidence, person]);
		expect(wherePredicates).toHaveLength(2);
	});
});

describe("organizationForSlug", () => {
	it("returns an existing organization rather than creating a second one for the same slug", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const existing: Organization = {
			id: "org-1",
			name: "Acme",
			slug: "acme.com",
			logo: null,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			metadata: null,
			domain: null,
		};
		let conflictTarget: IndexColumn | IndexColumn[] | undefined;
		const buildDb: DbFactory<OrganizationConnection> = () => ({
			insert: () => ({
				values: () => ({
					onConflictDoNothing: (config) => {
						conflictTarget = config?.target;
						return { returning: () => Promise.resolve([]) };
					},
				}),
			}),
			select: () => ({
				from: () => ({
					where: () => ({ limit: () => Promise.resolve([existing]) }),
				}),
			}),
		});

		const result = await organizationForSlug(env, "acme.com", "Acme", buildDb);

		expect(conflictTarget).toEqual([organization.slug]);
		expect(result).toEqual(existing);
	});
});

describe("openRun", () => {
	it("writes a row whose primary key is the supplied run id", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const newRun: NewRun = {
			id: "companies_icp-1_2026-08-27",
			organizationId: "org-1",
			icpId: "icp-1",
			capability: "companies",
			status: "running",
		};
		const storedRun: Run = {
			...newRun,
			icpId: newRun.icpId ?? null,
			costDollars: 0,
			startedAt: new Date("2026-08-27T00:00:00.000Z"),
			finishedAt: null,
		};
		const buildDb: DbFactory<RunOpenConnection> = () => ({
			insert: () => ({
				values: (values: NewRun | NewRun[]) => {
					expect(values).toEqual(newRun);
					return {
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([storedRun]),
						}),
					};
				},
			}),
			select: () => ({
				from: () => ({
					where: () => ({ limit: () => Promise.resolve([storedRun]) }),
				}),
			}),
		});

		const result = await openRun(env, newRun, buildDb);

		expect(result.id).toBe(newRun.id);
	});

	it("returns the existing run when a retried step re-inserts the same id", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const newRun: NewRun = {
			id: "companies_icp-1_2026-08-27",
			organizationId: "org-1",
			icpId: "icp-1",
			capability: "companies",
			status: "running",
		};
		const storedRun: Run = {
			...newRun,
			icpId: newRun.icpId ?? null,
			costDollars: 0,
			startedAt: new Date("2026-08-27T00:00:00.000Z"),
			finishedAt: null,
		};
		const modes: DbMode[] = [];
		const buildDb: DbFactory<RunOpenConnection> = (_env, mode) => {
			modes.push(mode);
			return {
				insert: () => ({
					values: () => ({
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([]),
						}),
					}),
				}),
				select: () => ({
					from: () => ({
						where: () => ({ limit: () => Promise.resolve([storedRun]) }),
					}),
				}),
			};
		};

		const result = await openRun(env, newRun, buildDb);

		expect(result.id).toBe(newRun.id);
		expect(modes).toContain("direct");
	});
});

describe("closeRun", () => {
	it("records the terminal status and the spend", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let setValues:
			| Partial<Pick<NewRun, "status" | "costDollars" | "finishedAt">>
			| undefined;
		const buildDb: DbFactory<RunUpdateConnection> = () => ({
			update: () => ({
				set: (values) => {
					setValues = values;
					return { where: () => Promise.resolve([]) };
				},
			}),
		});

		await closeRun(
			env,
			"run-1",
			{ status: "complete", costDollars: 4.5 },
			buildDb,
		);

		expect(setValues?.status).toBe("complete");
		expect(setValues?.costDollars).toBe(4.5);
		expect(setValues?.finishedAt).toBeInstanceOf(Date);
	});
});

describe("recordRunSpend", () => {
	it("writes the spend so far without ending the run", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let setValues:
			| Partial<Pick<NewRun, "status" | "costDollars" | "finishedAt">>
			| undefined;
		const buildDb: DbFactory<RunUpdateConnection> = () => ({
			update: () => ({
				set: (values) => {
					setValues = values;
					return { where: () => Promise.resolve([]) };
				},
			}),
		});

		await recordRunSpend(env, "run-1", 1.25, buildDb);

		expect(setValues?.costDollars).toBe(1.25);
		expect(setValues?.finishedAt).toBeUndefined();
		expect(setValues?.status).toBeUndefined();
	});
});

describe("organizationSpendToday", () => {
	it("reads through the direct binding, never cached", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let recordedMode: DbMode | undefined;
		const buildDb: DbFactory<OrganizationSpendConnection> = (_env, mode) => {
			recordedMode = mode;
			return {
				select: () => ({
					from: () => ({
						where: () => Promise.resolve([]),
					}),
				}),
			};
		};

		await organizationSpendToday(
			env,
			"org-1",
			new Date("2026-08-27T12:00:00.000Z"),
			buildDb,
		);

		expect(recordedMode).toBe("direct");
	});

	it("filters to the named organization and to today, summing every matching row", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const now = new Date("2026-08-27T12:00:00.000Z");
		let recordedCondition: unknown;
		const rows = [{ costDollars: 1.5 }, { costDollars: 2.25 }];
		const buildDb: DbFactory<OrganizationSpendConnection> = () => ({
			select: () => ({
				from: () => ({
					where: (condition) => {
						recordedCondition = condition;
						return Promise.resolve(rows);
					},
				}),
			}),
		});

		const total = await organizationSpendToday(env, "org-1", now, buildDb);

		expect(total).toBe(3.75);
		expect(recordedCondition).toEqual(
			and(
				eq(run.organizationId, "org-1"),
				gte(run.startedAt, startOfUtcDay(now)),
			),
		);
	});
});

describe("companiesForRun", () => {
	it("filters by run id, orders by found_at then id, and reads the saved Exa organization id off data", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let recordedCondition: unknown;
		let recordedOrder: unknown[] = [];
		const rows = [
			{
				id: "company-1",
				domain: "acme.com",
				name: "Acme",
				linkedinUrl: "https://linkedin.com/company/acme",
				icpId: "icp-1",
				data: { provider: "exa-search", result: { id: "exa-org-1" } },
			},
		];
		const buildDb: DbFactory<CompanyRunConnection> = () => ({
			select: () => ({
				from: () => ({
					where: (condition) => {
						recordedCondition = condition;
						return {
							orderBy: (...order: unknown[]) => {
								recordedOrder = order;
								return Promise.resolve(rows);
							},
						};
					},
				}),
			}),
		});

		const result = await companiesForRun(
			env,
			runRow({ id: "run-1", capability: "companies", status: "complete" }),
			buildDb,
		);

		expect(result).toEqual([
			{
				id: "company-1",
				domain: "acme.com",
				name: "Acme",
				linkedinUrl: "https://linkedin.com/company/acme",
				icpId: "icp-1",
				exaId: "exa-org-1",
			},
		]);
		expect(recordedCondition).toEqual(eq(company.runId, "run-1"));
		expect(recordedOrder).toEqual([company.foundAt, company.id]);
	});

	it("reports no Exa id for a company saved without one", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [
			{
				id: "company-2",
				domain: "agentco.com",
				name: "Agent Co",
				linkedinUrl: null,
				icpId: null,
				data: null,
			},
		];
		const buildDb: DbFactory<CompanyRunConnection> = () => ({
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => Promise.resolve(rows),
					}),
				}),
			}),
		});

		const result = await companiesForRun(
			env,
			runRow({ id: "run-2", capability: "companies", status: "complete" }),
			buildDb,
		);

		expect(result[0]?.exaId).toBeNull();
		expect(result[0]?.icpId).toBeNull();
	});

	it("resolves a people run's companies through its resolved run rows, not by run id", async () => {
		const fixture = await seedProfilelessPeopleRunFixture();

		try {
			const result = await companiesForRun(testEnv, fixture.peopleRunRow);

			expect(result.map((row) => row.id).sort()).toEqual(
				[...fixture.linkedCompanyIds].sort(),
			);
			expect(result.map((row) => row.id)).not.toContain(
				fixture.unlinkedCompanyId,
			);
		} finally {
			await cleanupProfilelessPeopleRunFixture(fixture);
		}
	});
});

describe("createCompanyRow", () => {
	it("returns no row from a conflicting insert, and re-selects the existing profiled row by organization, normalized domain and profile", async () => {
		const org = await seedOrganization("create-row-profiled");
		const icpRow = await createIcp(testEnv, {
			description: "seed icp for createCompanyRow",
			domain: `db-spec-create-row-${crypto.randomUUID()}.internal`,
			organizationId: org.id,
		});
		const runId = `companies_create-row-${crypto.randomUUID()}`;
		await openRun(testEnv, {
			id: runId,
			organizationId: org.id,
			icpId: icpRow.id,
			capability: "companies",
			status: "complete",
		});
		const domain = `create-row-${crypto.randomUUID()}.com`;
		const [existing] = await saveCompanies(testEnv, [
			{
				icpId: icpRow.id,
				organizationId: org.id,
				domain,
				name: "Existing Co",
				runId,
			},
		]);
		if (!existing) throw new Error("seed failed to save a company");

		try {
			const found = await createCompanyRow(testEnv, {
				icpId: icpRow.id,
				organizationId: org.id,
				domain: `https://WWW.${domain.toUpperCase()}/careers`,
				name: "Concurrent Co",
				runId,
			});

			expect(found.id).toBe(existing.id);
			expect(found.name).toBe("Existing Co");
		} finally {
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection.delete(company).where(eq(company.id, existing.id));
				await connection.delete(run).where(eq(run.id, runId));
				await connection.delete(icpTable).where(eq(icpTable.id, icpRow.id));
			});
			await cleanupOrganizations([org.id]);
		}
	});

	it("returns no row from a conflicting insert, and re-selects the existing orphan row by organization and normalized domain", async () => {
		const org = await seedOrganization("create-row-orphan");
		const runId = `people_create-row-${crypto.randomUUID()}`;
		await openRun(testEnv, {
			id: runId,
			organizationId: org.id,
			icpId: null,
			capability: "people",
			status: "complete",
		});
		const domain = `create-row-orphan-${crypto.randomUUID()}.com`;
		const [existing] = await saveCompanies(testEnv, [
			{
				icpId: null,
				organizationId: org.id,
				domain,
				name: "Existing Orphan",
				runId,
			},
		]);
		if (!existing) throw new Error("seed failed to save a company");

		try {
			const found = await createCompanyRow(testEnv, {
				icpId: null,
				organizationId: org.id,
				domain: `https://WWW.${domain.toUpperCase()}/`,
				name: "Concurrent Orphan",
				runId,
			});

			expect(found.id).toBe(existing.id);
			expect(found.name).toBe("Existing Orphan");
		} finally {
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection.delete(company).where(eq(company.id, existing.id));
				await connection.delete(run).where(eq(run.id, runId));
			});
			await cleanupOrganizations([org.id]);
		}
	});
});

describe("createCompanyRow: the fallback select's binding", () => {
	it("re-selects a concurrently inserted row through the direct binding, never cached", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const existing = companyRow("company-1");
		const modes: DbMode[] = [];
		const buildDb: DbFactory<CompanyCreateConnection> = (_env, mode) => {
			modes.push(mode);
			return {
				insert: () => ({
					values: () => ({
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([]),
						}),
					}),
				}),
				select: () => ({
					from: () => ({ where: () => Promise.resolve([existing]) }),
				}),
			};
		};

		const result = await createCompanyRow(
			env,
			{
				organizationId: "org-1",
				domain: "acme.com",
				name: "Acme",
				icpId: null,
				runId: "run-1",
			},
			buildDb,
		);

		expect(result.id).toBe(existing.id);
		expect(modes).toEqual(["cached", "direct"]);
	});
});

describe("saveRunCompanies: a domain the run already recorded", () => {
	it("re-selects the existing row through the direct binding instead of treating the conflict as a miss", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const existing = runCompanyRow("run-company-1");
		const modes: DbMode[] = [];
		const buildDb: DbFactory<
			RunCompanyInsertConnection & RunCompanyLookupConnection
		> = (_env, mode) => {
			modes.push(mode);
			return {
				insert: () => ({
					values: () => ({
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([]),
						}),
					}),
				}),
				select: () => ({
					from: () => ({ where: () => Promise.resolve([existing]) }),
				}),
			};
		};

		const [result] = await saveRunCompanies(
			env,
			[
				{
					runId: "run-1",
					domain: "acme.com",
					companyId: null,
					identity: null,
					mode: "roster",
					buyerSource: "none",
				},
			],
			buildDb,
		);

		expect(result).toEqual(existing);
		expect(modes).toEqual(["cached", "direct"]);
	});

	it("throws when the fallback select also finds nothing", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const buildDb: DbFactory<
			RunCompanyInsertConnection & RunCompanyLookupConnection
		> = () => ({
			insert: () => ({
				values: () => ({
					onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
				}),
			}),
			select: () => ({
				from: () => ({ where: () => Promise.resolve([]) }),
			}),
		});

		await expect(
			saveRunCompanies(
				env,
				[
					{
						runId: "run-1",
						domain: "acme.com",
						companyId: null,
						identity: null,
						mode: "roster",
						buyerSource: "none",
					},
				],
				buildDb,
			),
		).rejects.toThrow(/no row found/);
	});
});

describe("closeErroredRun", () => {
	it("closes the run as errored, keeping the spend already banked on the row", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let setValues:
			| Partial<Pick<NewRun, "status" | "costDollars" | "finishedAt">>
			| undefined;
		const storedRun: Run = {
			id: "run-1",
			organizationId: "org-1",
			icpId: null,
			capability: "people",
			status: "running",
			costDollars: 2.5,
			startedAt: new Date("2026-08-27T00:00:00.000Z"),
			finishedAt: null,
		};
		const buildDb: DbFactory<
			RunLookupConnection & RunUpdateConnection
		> = () => ({
			select: () => ({
				from: () => ({
					where: () => ({ limit: () => Promise.resolve([storedRun]) }),
				}),
			}),
			update: () => ({
				set: (values) => {
					setValues = values;
					return { where: () => Promise.resolve([]) };
				},
			}),
		});

		await closeErroredRun(env, "run-1", buildDb);

		expect(setValues?.status).toBe("errored");
		expect(setValues?.costDollars).toBe(2.5);
		expect(setValues?.finishedAt).toBeInstanceOf(Date);
	});

	it("is a harmless no-op, at zero cost, for a run that was never opened", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let setValues:
			| Partial<Pick<NewRun, "status" | "costDollars" | "finishedAt">>
			| undefined;
		const buildDb: DbFactory<
			RunLookupConnection & RunUpdateConnection
		> = () => ({
			select: () => ({
				from: () => ({
					where: () => ({ limit: () => Promise.resolve([]) }),
				}),
			}),
			update: () => ({
				set: (values) => {
					setValues = values;
					return { where: () => Promise.resolve([]) };
				},
			}),
		});

		await closeErroredRun(env, "missing-run", buildDb);

		expect(setValues?.status).toBe("errored");
		expect(setValues?.costDollars).toBe(0);
	});
});

function recordingCompanyPageDb(
	rows: Company[],
	spy: { condition?: unknown; order?: unknown; limit?: number },
): DbFactory<CompanyPageConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				where: (condition: unknown) => {
					spy.condition = condition;
					return {
						orderBy: (order: unknown) => {
							spy.order = order;
							return {
								limit: (count: number) => {
									spy.limit = count;
									return Promise.resolve(rows);
								},
							};
						},
					};
				},
			}),
		}),
	});
}

describe("companiesPage", () => {
	it("reports the last row's id as the next cursor only when a row is left over", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [companyRow("c1"), companyRow("c2"), companyRow("c3")];
		const buildDb = recordingCompanyPageDb(rows, {});

		const page = await companiesPage(
			env,
			runRow({ id: "run-1", capability: "companies", status: "complete" }),
			{ limit: 2, cursor: undefined },
			buildDb,
		);

		expect(page.rows.map((row) => row.id)).toEqual(["c1", "c2"]);
		expect(page.nextCursor).toBe("c2");
	});

	it("reports no next cursor when the read exactly fills the limit", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [companyRow("c1"), companyRow("c2")];
		const buildDb = recordingCompanyPageDb(rows, {});

		const page = await companiesPage(
			env,
			runRow({ id: "run-1", capability: "companies", status: "complete" }),
			{ limit: 2, cursor: undefined },
			buildDb,
		);

		expect(page.rows).toEqual(rows);
		expect(page.nextCursor).toBeNull();
	});
});

function recordingPersonPageDb(
	rows: Person[],
	spy: { join?: unknown; condition?: unknown; order?: unknown; limit?: number },
): DbFactory<PersonPageConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				innerJoin: (_table: typeof company, condition: unknown) => {
					spy.join = condition;
					return {
						where: (condition: unknown) => {
							spy.condition = condition;
							return {
								orderBy: (order: unknown) => {
									spy.order = order;
									return {
										limit: (count: number) => {
											spy.limit = count;
											return Promise.resolve(
												rows.map((row) => ({ person: row })),
											);
										},
									};
								},
							};
						},
					};
				},
			}),
		}),
	});
}

describe("peoplePage", () => {
	it("reports the last row's id as the next cursor only when a row is left over", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [personRow("p1"), personRow("p2"), personRow("p3")];
		const buildDb = recordingPersonPageDb(rows, {});

		const page = await peoplePage(
			env,
			runRow({ id: "run-1", capability: "companies", status: "complete" }),
			{ limit: 2, cursor: undefined },
			buildDb,
		);

		expect(page.rows.map((row) => row.id)).toEqual(["p1", "p2"]);
		expect(page.nextCursor).toBe("p2");
	});
});

describe("peoplePage scopes by what the run covers", () => {
	it("returns a companies run's own person, never another companies run's", async () => {
		const org = await seedOrganization("people-scope-companies");
		const icpRow = await createIcp(testEnv, {
			description: "seed icp for peoplePage companies-run scope test",
			domain: `people-scope-companies-${crypto.randomUUID()}.internal`,
			organizationId: org.id,
		});
		const runId = `companies_${crypto.randomUUID()}`;
		const otherRunId = `companies_${crypto.randomUUID()}`;
		const runRow = await openRun(testEnv, {
			id: runId,
			organizationId: org.id,
			icpId: icpRow.id,
			capability: "companies",
			status: "complete",
		});
		await openRun(testEnv, {
			id: otherRunId,
			organizationId: org.id,
			icpId: icpRow.id,
			capability: "companies",
			status: "complete",
		});
		const [ownCompany] = await saveCompanies(testEnv, [
			{
				icpId: icpRow.id,
				organizationId: org.id,
				runId,
				domain: `own-${crypto.randomUUID()}.com`,
				name: "Own Co",
			},
		]);
		const [otherCompany] = await saveCompanies(testEnv, [
			{
				icpId: icpRow.id,
				organizationId: org.id,
				runId: otherRunId,
				domain: `other-${crypto.randomUUID()}.com`,
				name: "Other Co",
			},
		]);
		if (!ownCompany || !otherCompany) {
			throw new Error("seed produced no company");
		}
		await upsertPeople(testEnv, [
			{
				organizationId: org.id,
				companyId: ownCompany.id,
				linkedinUrl: `https://linkedin.com/in/own-${crypto.randomUUID()}`,
				name: "Own Person",
				title: "VP of Sales",
			},
		]);
		await upsertPeople(testEnv, [
			{
				organizationId: org.id,
				companyId: otherCompany.id,
				linkedinUrl: `https://linkedin.com/in/other-${crypto.randomUUID()}`,
				name: "Other Person",
				title: "VP of Sales",
			},
		]);

		try {
			const page = await peoplePage(testEnv, runRow, {
				limit: 5,
				cursor: undefined,
			});

			expect(page.rows).toHaveLength(1);
			expect(page.rows[0]?.companyId).toBe(ownCompany.id);
		} finally {
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection
					.delete(person)
					.where(inArray(person.companyId, [ownCompany.id, otherCompany.id]));
				await connection
					.delete(company)
					.where(inArray(company.id, [ownCompany.id, otherCompany.id]));
				await connection
					.delete(run)
					.where(inArray(run.id, [runId, otherRunId]));
				await connection.delete(icpTable).where(eq(icpTable.id, icpRow.id));
			});
			await cleanupOrganizations([org.id]);
		}
	});

	it("hands back an empty page for an onboarding run, which covers no companies", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const spy: { condition?: unknown } = {};
		const buildDb = recordingPersonPageDb([], spy);

		const page = await peoplePage(
			env,
			runRow({ id: "onboarding_x", capability: "onboarding", icpId: null }),
			{ limit: 5, cursor: undefined },
			buildDb,
		);

		expect(page).toEqual({ rows: [], nextCursor: null });
		expect(spy.condition).toBeUndefined();
	});
});

function isRunCompanyPageRow(row: CompanyPageRow): row is RunCompanyPageRow {
	return "domain" in row && "runId" in row && "identity" in row;
}

describe("companiesPage: a people run's requested domains", () => {
	it("records an unresolved requested domain without a company", async () => {
		const org = await seedOrganization("unresolved");
		const runId = `people_unresolved-${crypto.randomUUID()}`;
		const runRow = await openRun(testEnv, {
			id: runId,
			organizationId: org.id,
			icpId: null,
			capability: "people",
			status: "complete",
		});
		const domain = `notacompany-${crypto.randomUUID()}.example`;
		await saveRunCompanies(testEnv, [
			{
				runId,
				domain,
				companyId: null,
				identity: "unresolved",
				mode: "roster",
				buyerSource: "none",
			},
		]);

		try {
			const page = await companiesPage(testEnv, runRow, {
				limit: 5,
				cursor: undefined,
			});

			expect(page.rows).toHaveLength(1);
			const row = page.rows[0];
			if (!row || !isRunCompanyPageRow(row)) {
				throw new Error("expected a run_company page row");
			}
			expect(row.domain).toBe(domain);
			expect(row.companyId).toBeNull();
			expect(row.company).toBeNull();
		} finally {
			await withConnection(testEnv, "direct", db, async (connection) => {
				await connection.delete(runCompany).where(eq(runCompany.runId, runId));
				await connection.delete(run).where(eq(run.id, runId));
			});
			await cleanupOrganizations([org.id]);
		}
	});
});

type ProfilelessPeopleRunFixture = {
	peopleRunRow: Run;
	peopleRunId: string;
	companiesRunId: string;
	orgA: Organization;
	orgB: Organization;
	linkedCompanyIds: [string, string];
	unlinkedCompanyId: string;
	companyIds: string[];
};

async function seedProfilelessCompanies(
	orgA: Organization,
	orgB: Organization,
	companiesRunId: string,
): Promise<[Company, Company, Company]> {
	const [companyA1, companyA2] = await saveCompanies(testEnv, [
		{
			icpId: null,
			organizationId: orgA.id,
			domain: `profileless-a1-${crypto.randomUUID()}.com`,
			name: "A1",
			runId: companiesRunId,
		},
		{
			icpId: null,
			organizationId: orgA.id,
			domain: `profileless-a2-${crypto.randomUUID()}.com`,
			name: "A2",
			runId: companiesRunId,
		},
	]);
	const [companyB] = await saveCompanies(testEnv, [
		{
			icpId: null,
			organizationId: orgB.id,
			domain: `profileless-b-${crypto.randomUUID()}.com`,
			name: "B",
			runId: companiesRunId,
		},
	]);
	if (!companyA1 || !companyA2 || !companyB) {
		throw new Error("seed failed to save a company");
	}
	return [companyA1, companyA2, companyB];
}

async function seedProfilelessPeopleRunFixture(): Promise<ProfilelessPeopleRunFixture> {
	const orgA = await seedOrganization("profileless-a");
	const orgB = await seedOrganization("profileless-b");
	const peopleRunId = `people_profileless-${crypto.randomUUID()}`;
	const peopleRunRow = await openRun(testEnv, {
		id: peopleRunId,
		organizationId: orgA.id,
		icpId: null,
		capability: "people",
		status: "complete",
	});
	const companiesRunId = `companies_profileless-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: companiesRunId,
		organizationId: orgA.id,
		icpId: null,
		capability: "companies",
		status: "complete",
	});
	const [companyA1, companyA2, companyB] = await seedProfilelessCompanies(
		orgA,
		orgB,
		companiesRunId,
	);
	await saveRunCompanies(testEnv, [
		{
			runId: peopleRunId,
			domain: companyA1.domain,
			companyId: companyA1.id,
			identity: "domain",
			mode: "roster",
			buyerSource: "none",
		},
		{
			runId: peopleRunId,
			domain: companyA2.domain,
			companyId: companyA2.id,
			identity: "domain",
			mode: "roster",
			buyerSource: "none",
		},
	]);
	const rosterData = {
		status: "roster",
		basis: null,
		seenBy: ["clay"],
		since: null,
		location: null,
	};
	await upsertPeople(testEnv, [
		{
			organizationId: orgA.id,
			companyId: companyA1.id,
			linkedinUrl: `https://linkedin.com/in/a1-${crypto.randomUUID()}`,
			name: "Person A1",
			data: rosterData,
		},
		{
			organizationId: orgA.id,
			companyId: companyA2.id,
			linkedinUrl: `https://linkedin.com/in/a2-${crypto.randomUUID()}`,
			name: "Person A2",
			data: rosterData,
		},
		{
			organizationId: orgB.id,
			companyId: companyB.id,
			linkedinUrl: `https://linkedin.com/in/b-${crypto.randomUUID()}`,
			name: "Person B",
			data: rosterData,
		},
	]);
	return {
		peopleRunRow,
		peopleRunId,
		companiesRunId,
		orgA,
		orgB,
		linkedCompanyIds: [companyA1.id, companyA2.id],
		unlinkedCompanyId: companyB.id,
		companyIds: [companyA1.id, companyA2.id, companyB.id],
	};
}

async function cleanupProfilelessPeopleRunFixture(
	fixture: ProfilelessPeopleRunFixture,
): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(runCompany)
			.where(eq(runCompany.runId, fixture.peopleRunId));
		await connection
			.delete(person)
			.where(inArray(person.companyId, fixture.companyIds));
		await connection
			.delete(company)
			.where(inArray(company.id, fixture.companyIds));
		await connection
			.delete(run)
			.where(inArray(run.id, [fixture.peopleRunId, fixture.companiesRunId]));
	});
	await cleanupOrganizations([fixture.orgA.id, fixture.orgB.id]);
}

describe("peoplePage: a profileless people run", () => {
	it("scopes a profileless people run through its resolved run rows", async () => {
		const fixture = await seedProfilelessPeopleRunFixture();

		try {
			const page = await peoplePage(testEnv, fixture.peopleRunRow, {
				limit: 10,
				cursor: undefined,
			});

			expect(page.rows.map((row) => row.name).sort()).toEqual([
				"Person A1",
				"Person A2",
			]);
		} finally {
			await cleanupProfilelessPeopleRunFixture(fixture);
		}
	});
});

type StoredStatusFixture = {
	org: Organization;
	companyId: string;
	targetRun: Run;
	rosterRun: Run;
};

async function seedStoredStatusFixture(): Promise<StoredStatusFixture> {
	const org = await seedOrganization("stored-status");
	const targetRunId = `people_stored-status-target-${crypto.randomUUID()}`;
	const targetRun = await openRun(testEnv, {
		id: targetRunId,
		organizationId: org.id,
		icpId: null,
		capability: "people",
		status: "complete",
	});
	const [savedCompany] = await saveCompanies(testEnv, [
		{
			icpId: null,
			organizationId: org.id,
			domain: `stored-status-${crypto.randomUUID()}.com`,
			name: "Stored Status Co",
			runId: targetRunId,
		},
	]);
	if (!savedCompany) throw new Error("seed failed to save a company");
	const rosterRunId = `people_stored-status-roster-${crypto.randomUUID()}`;
	const rosterRun = await openRun(testEnv, {
		id: rosterRunId,
		organizationId: org.id,
		icpId: null,
		capability: "people",
		status: "complete",
	});
	await saveRunCompanies(testEnv, [
		{
			runId: targetRunId,
			domain: savedCompany.domain,
			companyId: savedCompany.id,
			identity: "domain",
			mode: "target",
			buyerSource: "target",
		},
		{
			runId: rosterRunId,
			domain: savedCompany.domain,
			companyId: savedCompany.id,
			identity: "domain",
			mode: "roster",
			buyerSource: "none",
		},
	]);
	await upsertPeople(testEnv, [
		{
			organizationId: org.id,
			companyId: savedCompany.id,
			linkedinUrl: `https://linkedin.com/in/legacy-${crypto.randomUUID()}`,
			name: "Legacy Person",
		},
		{
			organizationId: org.id,
			companyId: savedCompany.id,
			linkedinUrl: `https://linkedin.com/in/roster-${crypto.randomUUID()}`,
			name: "Roster Person",
			data: {
				status: "roster",
				basis: null,
				seenBy: ["clay"],
				since: null,
				location: null,
			},
		},
		{
			organizationId: org.id,
			companyId: savedCompany.id,
			linkedinUrl: `https://linkedin.com/in/verified-${crypto.randomUUID()}`,
			name: "Verified Person",
			data: {
				status: "verified",
				basis: "champion",
				seenBy: ["exa"],
				since: null,
				location: null,
			},
		},
	]);
	return {
		org,
		companyId: savedCompany.id,
		targetRun,
		rosterRun,
	};
}

async function cleanupStoredStatusFixture(
	fixture: StoredStatusFixture,
): Promise<void> {
	const connection = db(testEnv, "direct");
	await connection
		.delete(runCompany)
		.where(
			inArray(runCompany.runId, [fixture.targetRun.id, fixture.rosterRun.id]),
		);
	await connection
		.delete(person)
		.where(eq(person.companyId, fixture.companyId));
	await connection.delete(company).where(eq(company.id, fixture.companyId));
	await connection
		.delete(run)
		.where(inArray(run.id, [fixture.targetRun.id, fixture.rosterRun.id]));
	await connection
		.delete(organization)
		.where(eq(organization.id, fixture.org.id));
}

describe("peoplePage: only the people this engine stored", () => {
	it("keeps only the verified row for a target-mode run, and both roster and verified for a roster-mode run", async () => {
		const fixture = await seedStoredStatusFixture();

		try {
			const targetPage = await peoplePage(testEnv, fixture.targetRun, {
				limit: 10,
				cursor: undefined,
			});
			expect(targetPage.rows.map((row) => row.name).sort()).toEqual([
				"Verified Person",
			]);

			const rosterPage = await peoplePage(testEnv, fixture.rosterRun, {
				limit: 10,
				cursor: undefined,
			});
			expect(rosterPage.rows.map((row) => row.name).sort()).toEqual([
				"Roster Person",
				"Verified Person",
			]);
		} finally {
			await cleanupStoredStatusFixture(fixture);
		}
	});
});

describe("saveRound", () => {
	const env = fakeEnv("postgres://cached", "postgres://direct");

	it("writes the round through the cached binding and hands back the row", async () => {
		const received: NewRound[] = [];
		let recordedMode: DbMode | undefined;
		const buildDb: DbFactory<RoundInsertConnection> = (_env, mode) => {
			recordedMode = mode;
			return {
				insert: () => ({
					values: (rows: NewRound | NewRound[]) => {
						received.push(...(Array.isArray(rows) ? rows : [rows]));
						return {
							onConflictDoNothing: () => ({
								returning: () => Promise.resolve([]),
							}),
						};
					},
				}),
			};
		};

		await saveRound(
			env,
			{
				runId: "run-1",
				ordinal: 2,
				plan: { query: "payment platforms" },
				found: 3,
				rejected: { filter: 1, gate: 2, judge: 4 },
			},
			buildDb,
		);

		expect(recordedMode).toBe("cached");
		expect(received[0]?.ordinal).toBe(2);
		expect(received[0]?.found).toBe(3);
		expect(received[0]?.plan).toEqual({ query: "payment platforms" });
	});

	it("targets the (run_id, ordinal) pair, so a replayed step never doubles a round", async () => {
		let conflictTarget: IndexColumn | IndexColumn[] | undefined;
		const buildDb: DbFactory<RoundInsertConnection> = () => ({
			insert: () => ({
				values: () => ({
					onConflictDoNothing: (config) => {
						conflictTarget = config?.target;
						return { returning: () => Promise.resolve([]) };
					},
				}),
			}),
		});

		await saveRound(
			env,
			{ runId: "run-1", ordinal: 1, plan: null, found: 0, rejected: null },
			buildDb,
		);

		expect(Array.isArray(conflictTarget)).toBe(true);
	});
});

describe("a round records why it refused, not only how many", () => {
	const env = fakeEnv("postgres://cached", "postgres://direct");

	it("stores the reject reasons alongside the counts", async () => {
		const received: NewRound[] = [];
		const buildDb: DbFactory<RoundInsertConnection> = () => ({
			insert: () => ({
				values: (rows: NewRound | NewRound[]) => {
					received.push(...(Array.isArray(rows) ? rows : [rows]));
					return {
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([]),
						}),
					};
				},
			}),
		});

		await saveRound(
			env,
			{
				runId: "run-1",
				ordinal: 1,
				plan: null,
				found: 1,
				rejected: { filter: 1, gate: 0, judge: 1 },
				rejects: [
					{
						domain: "a.com",
						reason: "evidence is 369 days old",
						stage: "filter",
					},
					{
						domain: "b.com",
						reason: "sells payments infrastructure",
						stage: "judge",
					},
				],
			},
			buildDb,
		);

		expect(received[0]?.rejects).toEqual([
			{ domain: "a.com", reason: "evidence is 369 days old", stage: "filter" },
			{
				domain: "b.com",
				reason: "sells payments infrastructure",
				stage: "judge",
			},
		]);
	});
});

type UpsertPeopleFixture = {
	org: Organization;
	runId: string;
	companyA: Company;
	companyB: Company;
	linkedinUrl: string;
};

async function seedUpsertPeopleFixture(
	label: string,
): Promise<UpsertPeopleFixture> {
	const org = await seedOrganization(label);
	const runId = `people_${label}-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: org.id,
		icpId: null,
		capability: "people",
		status: "complete",
	});
	const [companyA, companyB] = await saveCompanies(testEnv, [
		{
			icpId: null,
			organizationId: org.id,
			domain: `${label}-a-${crypto.randomUUID()}.com`,
			name: "Old Employer",
			runId,
		},
		{
			icpId: null,
			organizationId: org.id,
			domain: `${label}-b-${crypto.randomUUID()}.com`,
			name: "New Employer",
			runId,
		},
	]);
	if (!companyA || !companyB) {
		throw new Error("seed failed to save a company");
	}
	return {
		org,
		runId,
		companyA,
		companyB,
		linkedinUrl: `https://linkedin.com/in/upsert-${crypto.randomUUID()}`,
	};
}

async function cleanupUpsertPeopleFixture(
	fixture: UpsertPeopleFixture,
): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(person)
			.where(eq(person.organizationId, fixture.org.id));
		await connection
			.delete(company)
			.where(inArray(company.id, [fixture.companyA.id, fixture.companyB.id]));
		await connection.delete(run).where(eq(run.id, fixture.runId));
	});
	await cleanupOrganizations([fixture.org.id]);
}

describe("upsertPeople", () => {
	it("moves a verified person to the verified employer", async () => {
		const fixture = await seedUpsertPeopleFixture("upsert-move");

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: fixture.linkedinUrl,
					name: "Jordan Blake",
					title: "Manager",
					data: {
						status: "roster",
						basis: null,
						seenBy: ["clay"],
						since: null,
						location: null,
					},
				},
			]);

			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: fixture.linkedinUrl,
					name: "Jordan Blake",
					title: "VP Revenue",
					data: {
						status: "verified",
						basis: "champion",
						seenBy: ["clay", "exa"],
						since: "2026-01",
						location: "Austin, TX",
					},
				},
			]);

			expect(result).toHaveLength(1);
			expect(result[0]?.companyId).toBe(fixture.companyB.id);
			expect(result[0]?.title).toBe("VP Revenue");
			expect(result[0]?.data).toEqual({
				status: "verified",
				basis: "champion",
				seenBy: ["clay", "exa"],
				since: "2026-01",
				location: "Austin, TX",
			});
		} finally {
			await cleanupUpsertPeopleFixture(fixture);
		}
	});

	it("does not replace a verified person with roster data", async () => {
		const fixture = await seedUpsertPeopleFixture("upsert-keep");

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: fixture.linkedinUrl,
					name: "Riley Chen",
					title: "VP Revenue",
					data: {
						status: "verified",
						basis: "champion",
						seenBy: ["clay"],
						since: "2025-06",
						location: null,
					},
				},
			]);

			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: fixture.linkedinUrl,
					name: "Riley Chen",
					title: "Someone Else",
					data: {
						status: "roster",
						basis: null,
						seenBy: ["clay"],
						since: null,
						location: null,
					},
				},
			]);

			expect(result).toHaveLength(1);
			expect(result[0]?.companyId).toBe(fixture.companyA.id);
			expect(result[0]?.title).toBe("VP Revenue");
			expect(result[0]?.data).toEqual({
				status: "verified",
				basis: "champion",
				seenBy: ["clay"],
				since: "2025-06",
				location: null,
			});
		} finally {
			await cleanupUpsertPeopleFixture(fixture);
		}
	});
});

describe("upsertPeople: renamed linkedin url", () => {
	it("relinks a person whose linkedin slug changed since the last run, leaving one row for that name at that company", async () => {
		const fixture = await seedUpsertPeopleFixture("upsert-relink");
		const oldSlugUrl = `${fixture.linkedinUrl}-34742310`;
		const newSlugUrl = `${fixture.linkedinUrl}-rotated`;

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: oldSlugUrl,
					name: "Ettienne Gous",
					title: "Sales Manager",
					data: {
						status: "verified",
						basis: "champion",
						seenBy: ["clay"],
						since: "2025-01",
						location: null,
					},
				},
			]);

			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: newSlugUrl,
					name: "Ettienne Gous",
					title: "VP Sales",
					data: {
						status: "verified",
						basis: "champion",
						seenBy: ["clay"],
						since: "2026-01",
						location: "Cape Town",
					},
				},
			]);

			expect(result).toHaveLength(1);
			expect(result[0]?.linkedinUrl).toBe(newSlugUrl);
			expect(result[0]?.title).toBe("VP Sales");

			const stored = await withConnection(testEnv, "direct", db, (connection) =>
				connection
					.select()
					.from(person)
					.where(
						and(
							eq(person.organizationId, fixture.org.id),
							eq(person.companyId, fixture.companyA.id),
							eq(person.name, "Ettienne Gous"),
						),
					),
			);

			expect(stored).toHaveLength(1);
			expect(stored[0]?.linkedinUrl).toBe(newSlugUrl);
		} finally {
			await cleanupUpsertPeopleFixture(fixture);
		}
	});
});

describe("upsertPeople: same name at different companies", () => {
	it("keeps two different people with the same name at different companies separate", async () => {
		const fixture = await seedUpsertPeopleFixture("upsert-same-name");
		const urlAtCompanyA = `${fixture.linkedinUrl}-a`;
		const urlAtCompanyB = `${fixture.linkedinUrl}-b`;

		try {
			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: urlAtCompanyA,
					name: "Alex Kim",
					title: "Account Executive",
				},
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: urlAtCompanyB,
					name: "Alex Kim",
					title: "Product Manager",
				},
			]);

			expect(result).toHaveLength(2);

			const stored = await withConnection(testEnv, "direct", db, (connection) =>
				connection
					.select()
					.from(person)
					.where(
						and(
							eq(person.organizationId, fixture.org.id),
							eq(person.name, "Alex Kim"),
						),
					),
			);

			expect(stored).toHaveLength(2);
			expect(stored.map((row) => row.companyId).sort()).toEqual(
				[fixture.companyA.id, fixture.companyB.id].sort(),
			);
			expect(stored.map((row) => row.linkedinUrl).sort()).toEqual(
				[urlAtCompanyA, urlAtCompanyB].sort(),
			);
		} finally {
			await cleanupUpsertPeopleFixture(fixture);
		}
	});
});

describe("upsertPeople: renamed linkedin url from a roster row", () => {
	it("corrects the linkedin url without touching a verified person's title or data", async () => {
		const fixture = await seedUpsertPeopleFixture("upsert-relink-roster");
		const oldSlugUrl = `${fixture.linkedinUrl}-34742310`;
		const newSlugUrl = `${fixture.linkedinUrl}-rotated`;

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: oldSlugUrl,
					name: "Ettienne Gous",
					title: "Sales Manager",
					data: {
						status: "verified",
						basis: "champion",
						seenBy: ["clay"],
						since: "2025-01",
						location: null,
					},
				},
			]);

			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: newSlugUrl,
					name: "Ettienne Gous",
					title: "Someone Else",
					data: {
						status: "roster",
						basis: null,
						seenBy: ["clay"],
						since: null,
						location: null,
					},
				},
			]);

			expect(result).toHaveLength(1);
			expect(result[0]?.linkedinUrl).toBe(newSlugUrl);
			expect(result[0]?.title).toBe("Sales Manager");
			expect(result[0]?.data).toEqual({
				status: "verified",
				basis: "champion",
				seenBy: ["clay"],
				since: "2025-01",
				location: null,
			});

			const stored = await withConnection(testEnv, "direct", db, (connection) =>
				connection
					.select()
					.from(person)
					.where(
						and(
							eq(person.organizationId, fixture.org.id),
							eq(person.companyId, fixture.companyA.id),
							eq(person.name, "Ettienne Gous"),
						),
					),
			);

			expect(stored).toHaveLength(1);
			expect(stored[0]?.linkedinUrl).toBe(newSlugUrl);
		} finally {
			await cleanupUpsertPeopleFixture(fixture);
		}
	});
});

describe("upsertPeople: exact url match takes precedence over a namesake", () => {
	it("moves an exact linkedin url match ahead of a name match at the target company, leaving the target company's namesake untouched", async () => {
		const fixture = await seedUpsertPeopleFixture("upsert-precedence");
		const movedUrl = `${fixture.linkedinUrl}-moved`;
		const namesakeUrl = `${fixture.linkedinUrl}-namesake`;

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: movedUrl,
					name: "Jordan Blake",
					title: "Old Title",
				},
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: namesakeUrl,
					name: "Jordan Blake",
					title: "Namesake Title",
				},
			]);

			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: movedUrl,
					name: "Jordan Blake",
					title: "New Title",
					data: {
						status: "verified",
						basis: "champion",
						seenBy: ["clay"],
						since: "2026-01",
						location: null,
					},
				},
			]);

			expect(result).toHaveLength(1);
			expect(result[0]?.linkedinUrl).toBe(movedUrl);
			expect(result[0]?.companyId).toBe(fixture.companyB.id);
			expect(result[0]?.title).toBe("New Title");

			const stored = await withConnection(testEnv, "direct", db, (connection) =>
				connection
					.select()
					.from(person)
					.where(
						and(
							eq(person.organizationId, fixture.org.id),
							eq(person.name, "Jordan Blake"),
						),
					),
			);

			expect(stored).toHaveLength(2);
			const namesake = stored.find((row) => row.linkedinUrl === namesakeUrl);
			expect(namesake?.companyId).toBe(fixture.companyB.id);
			expect(namesake?.title).toBe("Namesake Title");
		} finally {
			await cleanupUpsertPeopleFixture(fixture);
		}
	});
});

type RunCompanyEvidenceFixture = {
	org: Organization;
	runId: string;
	runCompanyId: string;
};

async function seedRunCompanyEvidenceFixture(
	label: string,
): Promise<RunCompanyEvidenceFixture> {
	const org = await seedOrganization(label);
	const runId = `people_${label}-${crypto.randomUUID()}`;
	await openRun(testEnv, {
		id: runId,
		organizationId: org.id,
		icpId: null,
		capability: "people",
		status: "complete",
	});
	const domain = `${label}-${crypto.randomUUID()}.com`;
	const [runCompanyRow] = await saveRunCompanies(testEnv, [
		{
			runId,
			domain,
			companyId: null,
			identity: "domain",
			mode: "profile",
			buyerSource: "captured",
		},
	]);
	if (!runCompanyRow) {
		throw new Error("seed failed to save a run_company row");
	}
	return { org, runId, runCompanyId: runCompanyRow.id };
}

async function cleanupRunCompanyEvidenceFixture(
	fixture: RunCompanyEvidenceFixture,
): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(evidence)
			.where(eq(evidence.subjectId, fixture.runCompanyId));
		await connection
			.delete(runCompany)
			.where(eq(runCompany.runId, fixture.runId));
		await connection.delete(run).where(eq(run.id, fixture.runId));
	});
	await cleanupOrganizations([fixture.org.id]);
}

describe("rawEvidenceRow: stored on the requested-domain row", () => {
	it("attaches parsed replies to the requested-domain row", async () => {
		const fixture = await seedRunCompanyEvidenceFixture("evidence-attach");
		const identityBody = '{"search_id":"abc-123"}';
		const selectorBody = { picks: [{ id: 0, basis: "champion" }] };
		const verdictBody = {
			verdict: "CONTRADICTED",
			evidence_url: null,
			evidence_quote: null,
			evidence_kind: null,
			confidence: 0.4,
		};

		try {
			await appendEvidence(testEnv, [
				rawEvidenceRow(
					fixture.runCompanyId,
					"identity-create",
					"clay",
					identityBody,
				),
				rawEvidenceRow(
					fixture.runCompanyId,
					"select",
					"workerModel",
					selectorBody,
				),
				rawEvidenceRow(
					fixture.runCompanyId,
					"verify-1-poll-1",
					"exa",
					verdictBody,
				),
			]);

			const rows = await withConnection(testEnv, "direct", db, (connection) =>
				connection
					.select()
					.from(evidence)
					.where(eq(evidence.subjectId, fixture.runCompanyId)),
			);

			expect(rows).toHaveLength(3);
			for (const row of rows) {
				expect(row.subjectType).toBe("run_company");
				expect(row.subjectId).toBe(fixture.runCompanyId);
			}
			const identityRow = rows.find((row) => row.kind === "identity-create");
			expect(identityRow?.value).toBe(identityBody);
			const selectorRow = rows.find((row) => row.kind === "select");
			expect(selectorRow ? JSON.parse(selectorRow.value) : null).toEqual(
				selectorBody,
			);
			const verdictRow = rows.find((row) => row.kind === "verify-1-poll-1");
			expect(verdictRow ? JSON.parse(verdictRow.value) : null).toEqual(
				verdictBody,
			);
		} finally {
			await cleanupRunCompanyEvidenceFixture(fixture);
		}
	});

	it("accepts duplicate evidence from a retried write", async () => {
		const fixture = await seedRunCompanyEvidenceFixture("evidence-duplicate");
		const body = { verdict: "UNKNOWN" };

		try {
			const row = rawEvidenceRow(
				fixture.runCompanyId,
				"verify-1-poll-1",
				"exa",
				body,
			);
			await appendEvidence(testEnv, [row]);
			await appendEvidence(testEnv, [row]);

			const rows = await withConnection(testEnv, "direct", db, (connection) =>
				connection
					.select()
					.from(evidence)
					.where(eq(evidence.subjectId, fixture.runCompanyId)),
			);

			expect(rows).toHaveLength(2);
			expect(rows[0]?.value).toBe(JSON.stringify(body));
			expect(rows[1]?.value).toBe(JSON.stringify(body));
		} finally {
			await cleanupRunCompanyEvidenceFixture(fixture);
		}
	});
});
