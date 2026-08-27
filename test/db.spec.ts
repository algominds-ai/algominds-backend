import type { IndexColumn } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { DbEnv, DbMode } from "../src/core/db/client";
import { db } from "../src/core/db/client";
import type {
	CompanyInsertConnection,
	DbFactory,
	DeleteTransaction,
	DomainsConnection,
	EvidenceAppendConnection,
	EvidenceReadConnection,
	IcpConnection,
	PersonInsertConnection,
	TransactableConnection,
} from "../src/core/db/queries";
import {
	appendEvidence,
	cutoffDate,
	deletePerson,
	latestEvidence,
	loadIcp,
	recentDomains,
	saveCompanies,
	savePeople,
} from "../src/core/db/queries";
import type {
	Evidence,
	Icp,
	NewCompany,
	NewEvidence,
	NewPerson,
	Person,
} from "../src/core/db/schema";
import {
	company,
	evidence,
	normalizeDomain,
	person,
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

describe("loadIcp", () => {
	it("reads through the cached binding, not direct", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		const row: Icp = {
			id: "icp-1",
			domain: "acme.com",
			product: "widgets",
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
			[{ icpId: "icp-1", domain: "acme.com", name: "Acme" }],
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
	it("targets linkedin_url for dedupe, never name plus company", async () => {
		const env = fakeEnv("postgres://cached", "postgres://direct");
		let conflictTarget: IndexColumn | IndexColumn[] | undefined;
		const rows: NewPerson[] = [
			{ companyId: "company-1", linkedinUrl: "https://linkedin.com/in/x" },
		];
		const storedPerson: Person = {
			id: "person-1",
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

		expect(conflictTarget).toEqual([person.linkedinUrl]);
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
		const deletedTables: unknown[] = [];
		const wherePredicates: unknown[] = [];

		const fakeTx: DeleteTransaction = {
			delete: (table) => {
				deletedTables.push(table);
				return {
					where: (predicate) => {
						wherePredicates.push(predicate);
						return Promise.resolve();
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
