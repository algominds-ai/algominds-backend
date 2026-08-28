import { and, desc, eq, gte } from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import type { DbEnv, DbMode } from "@/core/db/client";
import { db } from "@/core/db/client";
import type {
	Account,
	Company,
	Evidence,
	Icp,
	NewAccount,
	NewCompany,
	NewEvidence,
	NewIcp,
	NewPerson,
	NewRun,
	Person,
	Run,
} from "@/core/db/schema";
import {
	account,
	company,
	evidence,
	icp,
	normalizeDomain,
	person,
	run,
} from "@/core/db/schema";

export type DbFactory<TConnection> = (env: DbEnv, mode: DbMode) => TConnection;

export interface SelectWhereConnection<TTable, TColumns, TRow> {
	select(columns: TColumns): {
		from(table: TTable): {
			where(condition: unknown): Promise<TRow[]>;
		};
	};
}

interface SelectLimitConnection<TTable, TRow> {
	select(): {
		from(table: TTable): {
			where(condition: unknown): {
				limit(count: number): Promise<TRow[]>;
			};
		};
	};
}

interface SelectAllWhereConnection<TTable, TRow> {
	select(): {
		from(table: TTable): {
			where(condition: unknown): Promise<TRow[]>;
		};
	};
}

interface UpdateWhereConnection<TTable, TValues> {
	update(table: TTable): {
		set(values: TValues): {
			where(condition: unknown): Promise<unknown>;
		};
	};
}

interface SelectOrderedConnection<TTable, TRow> {
	select(): {
		from(table: TTable): {
			where(condition: unknown): {
				orderBy(order: unknown): {
					limit(count: number): Promise<TRow[]>;
				};
			};
		};
	};
}

interface InsertChain<TRow> {
	onConflictDoNothing(config?: { target?: IndexColumn | IndexColumn[] }): {
		returning(): Promise<TRow[]>;
	};
}

interface InsertConnection<TTable, TNewRow, TRow> {
	insert(table: TTable): {
		values(row: TNewRow): InsertChain<TRow>;
		values(rows: TNewRow[]): InsertChain<TRow>;
	};
}

interface AppendChain<TRow> {
	returning(): Promise<TRow[]>;
}

interface AppendConnection<TTable, TNewRow, TRow> {
	insert(table: TTable): {
		values(row: TNewRow): AppendChain<TRow>;
		values(rows: TNewRow[]): AppendChain<TRow>;
	};
}

export interface DeleteTransaction {
	delete(table: typeof evidence | typeof person): {
		where(condition: unknown): Promise<unknown>;
	};
}

export interface TransactableConnection {
	transaction<T>(fn: (tx: DeleteTransaction) => Promise<T>): Promise<T>;
}

export type IcpConnection = SelectLimitConnection<typeof icp, Icp>;
export type IcpInsertConnection = AppendConnection<typeof icp, NewIcp, Icp>;
export type DomainsConnection = SelectWhereConnection<
	typeof company,
	{ domain: typeof company.domain },
	{ domain: string }
>;
export type EvidenceReadConnection = SelectOrderedConnection<
	typeof evidence,
	Evidence
>;
export type CompanyInsertConnection = InsertConnection<
	typeof company,
	NewCompany,
	Company
>;
export type PersonInsertConnection = InsertConnection<
	typeof person,
	NewPerson,
	Person
>;
export type EvidenceAppendConnection = AppendConnection<
	typeof evidence,
	NewEvidence,
	Evidence
>;
export type AccountConnection = InsertConnection<
	typeof account,
	NewAccount,
	Account
> &
	SelectAllWhereConnection<typeof account, Account>;
export type RunInsertConnection = AppendConnection<typeof run, NewRun, Run>;
export type RunOpenConnection = InsertConnection<typeof run, NewRun, Run> &
	SelectLimitConnection<typeof run, Run>;
export type RunUpdateConnection = UpdateWhereConnection<
	typeof run,
	Pick<NewRun, "status" | "costDollars" | "finishedAt">
>;
export type RunLookupConnection = SelectLimitConnection<typeof run, Run>;
export type AccountSpendConnection = SelectWhereConnection<
	typeof run,
	{ costDollars: typeof run.costDollars },
	{ costDollars: number }
>;
export type RunCompany = Pick<Company, "id" | "domain" | "name">;
export type CompanyRunConnection = SelectWhereConnection<
	typeof company,
	{
		id: typeof company.id;
		domain: typeof company.domain;
		name: typeof company.name;
	},
	RunCompany
>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The instant `days` days before `now` (defaults to the current time). */
export function cutoffDate(days: number, now: Date = new Date()): Date {
	return new Date(now.getTime() - days * MS_PER_DAY);
}

export async function loadIcp(
	env: DbEnv,
	icpId: string,
	buildDb: DbFactory<IcpConnection> = db,
): Promise<Icp | undefined> {
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select()
		.from(icp)
		.where(eq(icp.id, icpId))
		.limit(1);
	return rows[0];
}

export type NewIcpInput = Pick<NewIcp, "domain" | "accountId"> & {
	description: string;
};

/** Stores a free-text ideal customer profile and returns the stored row. */
export async function createIcp(
	env: DbEnv,
	input: NewIcpInput,
	buildDb: DbFactory<IcpInsertConnection> = db,
): Promise<Icp> {
	const connection = buildDb(env, "cached");
	const rows = await connection
		.insert(icp)
		.values({
			domain: input.domain,
			accountId: input.accountId,
			doc: { description: input.description },
		})
		.returning();
	const row = rows[0];
	if (!row) throw new Error("createIcp: insert returned no row");
	return row;
}

/** Finds the account for `domain`, creating it with `name` if it does not exist. */
export async function ensureAccount(
	env: DbEnv,
	name: string,
	domain: string,
	buildDb: DbFactory<AccountConnection> = db,
): Promise<Account> {
	const connection = buildDb(env, "cached");
	const inserted = await connection
		.insert(account)
		.values({ name, domain })
		.onConflictDoNothing({ target: [account.domain] })
		.returning();
	if (inserted[0]) return inserted[0];
	const rows = await connection
		.select()
		.from(account)
		.where(eq(account.domain, domain));
	const row = rows[0];
	if (!row) throw new Error(`ensureAccount: no account for domain ${domain}`);
	return row;
}

/** Opens a run, or returns the one already opened under this id. A retried step must not fail on the primary key it just wrote. */
export async function openRun(
	env: DbEnv,
	newRun: NewRun,
	buildDb: DbFactory<RunOpenConnection> = db,
): Promise<Run> {
	const connection = buildDb(env, "cached");
	const inserted = await connection
		.insert(run)
		.values(newRun)
		.onConflictDoNothing({ target: [run.id] })
		.returning();
	const created = inserted[0];
	if (created) return created;
	const existing = await buildDb(env, "direct")
		.select()
		.from(run)
		.where(eq(run.id, newRun.id))
		.limit(1);
	const row = existing[0];
	if (!row) throw new Error(`openRun: no run for id ${newRun.id}`);
	return row;
}

/**
 * The run row for `runId`, if one exists, read through the cache-disabled
 * binding so a start from earlier in this same request is never missed.
 */
export async function findRun(
	env: DbEnv,
	runId: string,
	buildDb: DbFactory<RunLookupConnection> = db,
): Promise<Run | undefined> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select()
		.from(run)
		.where(eq(run.id, runId))
		.limit(1);
	return rows[0];
}

/** Records a run's terminal status and spend, and stamps `finished_at`. */
export async function closeRun(
	env: DbEnv,
	runId: string,
	outcome: Pick<NewRun, "status" | "costDollars">,
	buildDb: DbFactory<RunUpdateConnection> = db,
): Promise<void> {
	const connection = buildDb(env, "cached");
	await connection
		.update(run)
		.set({ ...outcome, finishedAt: new Date() })
		.where(eq(run.id, runId));
}

/** Midnight UTC on the day of `now` (defaults to the current time). */
export function startOfUtcDay(now: Date = new Date()): Date {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
}

/**
 * Sums an account's run spend since the start of the current UTC day, read
 * through the cache-disabled binding so a same-run write is never missed.
 */
export async function accountSpendToday(
	env: DbEnv,
	accountId: string,
	now: Date = new Date(),
	buildDb: DbFactory<AccountSpendConnection> = db,
): Promise<number> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select({ costDollars: run.costDollars })
		.from(run)
		.where(
			and(eq(run.accountId, accountId), gte(run.startedAt, startOfUtcDay(now))),
		);
	return rows.reduce((total, row) => total + row.costDollars, 0);
}

/** The id, domain, and name of every company found in run `runId`. */
export async function companiesForRun(
	env: DbEnv,
	runId: string,
	buildDb: DbFactory<CompanyRunConnection> = db,
): Promise<RunCompany[]> {
	const connection = buildDb(env, "cached");
	return connection
		.select({ id: company.id, domain: company.domain, name: company.name })
		.from(company)
		.where(eq(company.runId, runId));
}

/**
 * Domains found for an ICP within the trailing `days` days, read through
 * the cache-disabled binding.
 */
export async function recentDomains(
	env: DbEnv,
	icpId: string,
	days: number,
	buildDb: DbFactory<DomainsConnection> = db,
): Promise<string[]> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select({ domain: company.domain })
		.from(company)
		.where(
			and(eq(company.icpId, icpId), gte(company.foundAt, cutoffDate(days))),
		);
	return rows.map((row) => row.domain);
}

export async function saveCompanies(
	env: DbEnv,
	rows: NewCompany[],
	buildDb: DbFactory<CompanyInsertConnection> = db,
): Promise<Company[]> {
	if (rows.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	const normalized = rows.map((row) => ({
		...row,
		domain: normalizeDomain(row.domain),
	}));
	return connection
		.insert(company)
		.values(normalized)
		.onConflictDoNothing({ target: [company.icpId, company.domain] })
		.returning();
}

export async function savePeople(
	env: DbEnv,
	rows: NewPerson[],
	buildDb: DbFactory<PersonInsertConnection> = db,
): Promise<Person[]> {
	if (rows.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	return connection
		.insert(person)
		.values(rows)
		.onConflictDoNothing({ target: [person.linkedinUrl] })
		.returning();
}

export async function appendEvidence(
	env: DbEnv,
	rows: NewEvidence[],
	buildDb: DbFactory<EvidenceAppendConnection> = db,
): Promise<Evidence[]> {
	if (rows.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	return connection.insert(evidence).values(rows).returning();
}

export async function latestEvidence(
	env: DbEnv,
	subjectId: string,
	kind: string,
	buildDb: DbFactory<EvidenceReadConnection> = db,
): Promise<Evidence | undefined> {
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select()
		.from(evidence)
		.where(and(eq(evidence.subjectId, subjectId), eq(evidence.kind, kind)))
		.orderBy(desc(evidence.seenAt))
		.limit(1);
	return rows[0];
}

/** Deletes a person and every evidence row recorded for them, in one transaction. */
export async function deletePerson(
	env: DbEnv,
	personId: string,
	buildDb: DbFactory<TransactableConnection> = db,
): Promise<void> {
	const connection = buildDb(env, "cached");
	await connection.transaction(async (tx) => {
		await tx
			.delete(evidence)
			.where(
				and(
					eq(evidence.subjectType, "person"),
					eq(evidence.subjectId, personId),
				),
			);
		await tx.delete(person).where(eq(person.id, personId));
	});
}
