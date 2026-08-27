import { and, desc, eq, gte } from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import type { DbEnv, DbMode } from "@/core/db/client";
import { db } from "@/core/db/client";
import type {
	Company,
	Evidence,
	Icp,
	NewCompany,
	NewEvidence,
	NewPerson,
	Person,
} from "@/core/db/schema";
import {
	company,
	evidence,
	icp,
	normalizeDomain,
	person,
} from "@/core/db/schema";

export type DbFactory<TConnection> = (env: DbEnv, mode: DbMode) => TConnection;

interface SelectWhereConnection<TTable, TColumns, TRow> {
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
