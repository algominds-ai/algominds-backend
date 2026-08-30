import type { SQL } from "drizzle-orm";
import { and, asc, eq, gt, gte } from "drizzle-orm";
import type { IndexColumn, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { organization } from "../src/core/db/auth-schema";
import type { DbEnv, DbMode } from "../src/core/db/client";
import { db } from "../src/core/db/client";
import type { KnownPeopleConnection } from "../src/core/db/known-people";
import { knownPeopleDomains } from "../src/core/db/known-people";
import { organizationForSlug } from "../src/core/db/organizations";
import type {
	CompanyInsertConnection,
	CompanyRunConnection,
	DbFactory,
	DeleteTransaction,
	DomainsConnection,
	EvidenceAppendConnection,
	EvidenceReadConnection,
	IcpConnection,
	Organization,
	OrganizationConnection,
	OrganizationSpendConnection,
	PersonInsertConnection,
	RoundInsertConnection,
	RunOpenConnection,
	RunUpdateConnection,
	TransactableConnection,
} from "../src/core/db/queries";
import {
	appendEvidence,
	closeRun,
	companiesForRun,
	cutoffDate,
	deletePerson,
	latestEvidence,
	loadIcp,
	openRun,
	organizationSpendToday,
	recentDomains,
	recordRunSpend,
	saveCompanies,
	savePeople,
	saveRound,
	startOfUtcDay,
} from "../src/core/db/queries";
import type {
	CompanyPageConnection,
	PersonPageConnection,
} from "../src/core/db/run-pages";
import { companiesPage, peoplePage } from "../src/core/db/run-pages";
import type {
	Company,
	Evidence,
	Icp,
	NewCompany,
	NewEvidence,
	NewPerson,
	NewRound,
	NewRun,
	Person,
	Run,
} from "../src/core/db/schema";
import {
	company,
	evidence,
	normalizeDomain,
	person,
	run,
} from "../src/core/db/schema";

function fakeEnv(cached: string, direct: string): DbEnv {
	return {
		HYPERDRIVE_CACHED: { connectionString: cached },
		HYPERDRIVE_DIRECT: { connectionString: direct },
	};
}

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
	];

	for (const [input, expected] of cases) {
		it(`normalizes ${input} to ${expected}`, () => {
			expect(normalizeDomain(input)).toBe(expected);
		});
	}

	it("does not strip a non-www subdomain", () => {
		expect(normalizeDomain("shop.acme.com")).toBe("shop.acme.com");
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
						where: () => Promise.resolve(rows),
					}),
				}),
			};
		};

		const result = await recentDomains(env, "icp-1", 90, buildDb);

		expect(recordedMode).toBe("direct");
		expect(result).toEqual(["acme.com", "beta.com"]);
	});
});

function knownCompanyRow(domain: string): Company {
	return {
		id: "company-1",
		icpId: "icp-1",
		domain,
		name: "Acme",
		linkedinUrl: null,
		industry: null,
		data: null,
		runId: "run-1",
		foundAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

describe("knownPeopleDomains", () => {
	it("reads through the direct binding, never cached", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let recordedMode: DbMode | undefined;
		const rows = [{ company: knownCompanyRow("acme.com") }];

		const buildDb: DbFactory<KnownPeopleConnection> = (_env, mode) => {
			recordedMode = mode;
			return {
				select: () => ({
					from: () => ({
						innerJoin: () => ({
							innerJoin: () => ({
								innerJoin: () => ({
									where: () => Promise.resolve(rows),
								}),
							}),
						}),
					}),
				}),
			};
		};

		const result = await knownPeopleDomains(
			env,
			"org-1",
			{ days: 90 },
			buildDb,
		);

		expect(recordedMode).toBe("direct");
		expect(result).toEqual(["acme.com"]);
	});

	it("joins company to run to person to evidence, and scopes to the organization, the person's evidence, and the window", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const now = new Date("2026-08-27T00:00:00.000Z");
		let firstJoin: unknown;
		let secondJoin: unknown;
		let thirdJoin: unknown;
		let recordedCondition: unknown;

		const buildDb: DbFactory<KnownPeopleConnection> = () => ({
			select: () => ({
				from: () => ({
					innerJoin: (_runTable, condition) => {
						firstJoin = condition;
						return {
							innerJoin: (_personTable, condition2) => {
								secondJoin = condition2;
								return {
									innerJoin: (_evidenceTable, condition3) => {
										thirdJoin = condition3;
										return {
											where: (condition4: unknown) => {
												recordedCondition = condition4;
												return Promise.resolve([]);
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

		await knownPeopleDomains(env, "org-1", { days: 90, now }, buildDb);

		expect(firstJoin).toEqual(eq(company.runId, run.id));
		expect(secondJoin).toEqual(eq(person.companyId, company.id));
		expect(thirdJoin).toEqual(eq(evidence.subjectId, person.id));
		expect(recordedCondition).toEqual(
			and(
				eq(run.organizationId, "org-1"),
				eq(evidence.subjectType, "person"),
				eq(evidence.kind, "fullName"),
				gte(evidence.seenAt, cutoffDate(90, now)),
			),
		);
	});
});

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
			[{ icpId: "icp-1", domain: "acme.com", name: "Acme", runId: "run-1" }],
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

describe("savePeople", () => {
	it("targets organization plus linkedin_url for dedupe, never name plus company", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let conflictTarget: IndexColumn | IndexColumn[] | undefined;
		const rows: NewPerson[] = [
			{
				organizationId: "org-1",
				companyId: "company-1",
				linkedinUrl: "https://linkedin.com/in/x",
			},
		];
		const storedPerson: Person = {
			id: "person-1",
			organizationId: "org-1",
			companyId: "company-1",
			linkedinUrl: "https://linkedin.com/in/x",
			name: null,
			title: null,
			data: null,
		};
		const buildDb: DbFactory<PersonInsertConnection> = () => ({
			insert: () => ({
				values: () => ({
					onConflictDoNothing: (config) => {
						conflictTarget = config?.target;
						return { returning: () => Promise.resolve([storedPerson]) };
					},
				}),
			}),
		});

		const result = await savePeople(env, rows, buildDb);

		expect(conflictTarget).toEqual([person.organizationId, person.linkedinUrl]);
		expect(result).toEqual([storedPerson]);
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
	it("filters by run id and reads the saved Exa organization id off data", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let recordedCondition: unknown;
		const rows = [
			{
				id: "company-1",
				domain: "acme.com",
				name: "Acme",
				data: { provider: "exa-search", result: { id: "exa-org-1" } },
			},
		];
		const buildDb: DbFactory<CompanyRunConnection> = () => ({
			select: () => ({
				from: () => ({
					where: (condition) => {
						recordedCondition = condition;
						return Promise.resolve(rows);
					},
				}),
			}),
		});

		const result = await companiesForRun(env, "run-1", buildDb);

		expect(result).toEqual([
			{ id: "company-1", domain: "acme.com", name: "Acme", exaId: "exa-org-1" },
		]);
		expect(recordedCondition).toEqual(eq(company.runId, "run-1"));
	});

	it("reports no Exa id for a company saved without one", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [
			{ id: "company-2", domain: "agentco.com", name: "Agent Co", data: null },
		];
		const buildDb: DbFactory<CompanyRunConnection> = () => ({
			select: () => ({
				from: () => ({
					where: () => Promise.resolve(rows),
				}),
			}),
		});

		const result = await companiesForRun(env, "run-2", buildDb);

		expect(result[0]?.exaId).toBeNull();
	});
});

function companyRow(id: string): Company {
	return {
		id,
		icpId: "icp-1",
		domain: `${id}.com`,
		name: id,
		linkedinUrl: null,
		industry: null,
		data: null,
		runId: "run-1",
		foundAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

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
	it("filters by run id and orders by id ascending when there is no cursor", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [companyRow("company-1"), companyRow("company-2")];
		const spy: { condition?: unknown; order?: unknown; limit?: number } = {};
		const buildDb = recordingCompanyPageDb(rows, spy);

		const page = await companiesPage(
			env,
			"run-1",
			{ limit: 5, cursor: undefined },
			buildDb,
		);

		expect(spy.condition).toEqual(eq(company.runId, "run-1"));
		expect(spy.order).toEqual(asc(company.id));
		expect(spy.limit).toBe(6);
		expect(page.rows).toEqual(rows);
		expect(page.nextCursor).toBeNull();
	});

	it("adds an id-greater-than-cursor condition when a cursor is given", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const spy: { condition?: unknown } = {};
		const buildDb = recordingCompanyPageDb([], spy);

		await companiesPage(
			env,
			"run-1",
			{ limit: 5, cursor: "company-1" },
			buildDb,
		);

		expect(spy.condition).toEqual(
			and(eq(company.runId, "run-1"), gt(company.id, "company-1")),
		);
	});

	it("reports the last row's id as the next cursor only when a row is left over", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [companyRow("c1"), companyRow("c2"), companyRow("c3")];
		const buildDb = recordingCompanyPageDb(rows, {});

		const page = await companiesPage(
			env,
			"run-1",
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
			"run-1",
			{ limit: 2, cursor: undefined },
			buildDb,
		);

		expect(page.rows).toEqual(rows);
		expect(page.nextCursor).toBeNull();
	});
});

function personRow(id: string): Person {
	return {
		id,
		organizationId: "org-1",
		companyId: "company-1",
		linkedinUrl: `https://linkedin.com/in/${id}`,
		name: id,
		title: null,
		data: null,
	};
}

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

function testRun(fields: {
	id: string;
	capability: string;
	icpId?: string;
}): Run {
	return {
		id: fields.id,
		organizationId: "org-1",
		icpId: fields.icpId ?? "icp-1",
		capability: fields.capability,
		status: "complete",
		costDollars: 0,
		startedAt: new Date("2026-08-28T00:00:00Z"),
		finishedAt: null,
	};
}

describe("peoplePage", () => {
	it("joins on the person's company, filters by run id, and orders by id ascending", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [personRow("person-1")];
		const spy: {
			join?: unknown;
			condition?: unknown;
			order?: unknown;
			limit?: number;
		} = {};
		const buildDb = recordingPersonPageDb(rows, spy);

		const page = await peoplePage(
			env,
			testRun({ id: "run-1", capability: "companies" }),
			{ limit: 5, cursor: undefined },
			buildDb,
		);

		expect(spy.join).toEqual(eq(person.companyId, company.id));
		expect(spy.condition).toEqual(eq(company.runId, "run-1"));
		expect(spy.order).toEqual(asc(person.id));
		expect(spy.limit).toBe(6);
		expect(page.rows).toEqual(rows);
		expect(page.nextCursor).toBeNull();
	});

	it("adds an id-greater-than-cursor condition when a cursor is given", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const spy: { condition?: unknown } = {};
		const buildDb = recordingPersonPageDb([], spy);

		await peoplePage(
			env,
			testRun({ id: "run-1", capability: "companies" }),
			{ limit: 5, cursor: "person-1" },
			buildDb,
		);

		expect(spy.condition).toEqual(
			and(eq(company.runId, "run-1"), gt(person.id, "person-1")),
		);
	});

	it("reports the last row's id as the next cursor only when a row is left over", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const rows = [personRow("p1"), personRow("p2"), personRow("p3")];
		const buildDb = recordingPersonPageDb(rows, {});

		const page = await peoplePage(
			env,
			testRun({ id: "run-1", capability: "companies" }),
			{ limit: 2, cursor: undefined },
			buildDb,
		);

		expect(page.rows.map((row) => row.id)).toEqual(["p1", "p2"]);
		expect(page.nextCursor).toBe("p2");
	});
});

describe("peoplePage scopes by what the run covers", () => {
	it("reads a people run through its profile, not through a company run id it never owned", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const spy: { condition?: unknown } = {};
		const buildDb = recordingPersonPageDb([], spy);

		await peoplePage(
			env,
			testRun({ id: "people_x", capability: "people", icpId: "icp-7" }),
			{ limit: 5, cursor: undefined },
			buildDb,
		);

		expect(spy.condition).toEqual(eq(company.icpId, "icp-7"));
	});

	it("still reads a companies run through its own run id", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const spy: { condition?: unknown } = {};
		const buildDb = recordingPersonPageDb([], spy);

		await peoplePage(
			env,
			testRun({ id: "companies_x", capability: "companies" }),
			{ limit: 5, cursor: undefined },
			buildDb,
		);

		expect(spy.condition).toEqual(eq(company.runId, "companies_x"));
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
