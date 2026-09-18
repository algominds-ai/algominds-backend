import type { SQL } from "drizzle-orm";
import { and, desc, eq } from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import { organization } from "@/core/db/auth-schema";
import type { DbEnv, DbFactory } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type {
	Company,
	Evidence,
	Icp,
	NewCompany,
	NewEvidence,
	NewIcp,
	NewPerson,
	NewRound,
	NewRun,
	Person,
	Round,
	Run,
} from "@/core/db/schema";
import {
	company,
	evidence,
	type icp,
	normalizeDomain,
	type person,
	round,
	type run,
} from "@/core/db/schema";

export type Organization = typeof organization.$inferSelect;
export type NewOrganization = typeof organization.$inferInsert;

export type { DbFactory };

export interface SelectWhereConnection<TTable, TColumns, TRow> {
	select(columns: TColumns): {
		from(table: TTable): {
			where(condition: SQL | undefined): Promise<TRow[]>;
		};
	};
}

interface SelectLimitConnection<TTable, TRow> {
	select(): {
		from(table: TTable): {
			where(condition: SQL | undefined): {
				limit(count: number): Promise<TRow[]>;
			};
		};
	};
}

export interface SelectAllWhereConnection<TTable, TRow> {
	select(): {
		from(table: TTable): {
			where(condition: SQL | undefined): Promise<TRow[]>;
		};
	};
}

export interface UpdateWhereConnection<TTable, TValues> {
	update(table: TTable): {
		set(values: TValues): {
			where(condition: SQL | undefined): Promise<never[]>;
		};
	};
}

export interface SelectOrderedConnection<TTable, TRow> {
	select(): {
		from(table: TTable): {
			where(condition: SQL | undefined): {
				orderBy(order: SQL): {
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

export interface InsertConnection<TTable, TNewRow, TRow> {
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

export type IcpConnection = SelectLimitConnection<typeof icp, Icp>;
export type IcpInsertConnection = AppendConnection<typeof icp, NewIcp, Icp>;
export type IcpDocUpdateConnection = SelectLimitConnection<typeof icp, Icp> &
	UpdateWhereConnection<typeof icp, Pick<NewIcp, "doc">>;
export interface DomainsConnection {
	select(columns: { domain: typeof company.domain }): {
		from(table: typeof company): {
			where(condition: SQL | undefined): {
				orderBy(order: SQL): Promise<{ domain: string }[]>;
			};
		};
	};
}
export type EvidenceReadConnection = SelectOrderedConnection<
	typeof evidence,
	Evidence
>;
export type CompanyInsertConnection = InsertConnection<
	typeof company,
	NewCompany,
	Company
>;
export type RoundInsertConnection = InsertConnection<
	typeof round,
	NewRound,
	Round
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
export type OrganizationConnection = InsertConnection<
	typeof organization,
	NewOrganization,
	Organization
> &
	SelectLimitConnection<typeof organization, Organization>;
export type RunInsertConnection = AppendConnection<typeof run, NewRun, Run>;
export type RunOpenConnection = InsertConnection<typeof run, NewRun, Run> &
	SelectLimitConnection<typeof run, Run>;
export type RunUpdateConnection = UpdateWhereConnection<
	typeof run,
	Partial<Pick<NewRun, "status" | "costDollars" | "finishedAt">>
>;
export type RunLookupConnection = SelectLimitConnection<typeof run, Run>;
export type OrganizationSpendConnection = SelectWhereConnection<
	typeof run,
	{ costDollars: typeof run.costDollars },
	{ costDollars: number }
>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The instant `days` days before `now` (defaults to the current time). */
export function cutoffDate(days: number, now: Date = new Date()): Date {
	return new Date(now.getTime() - days * MS_PER_DAY);
}

export type OrganizationSelectConnection = SelectAllWhereConnection<
	typeof organization,
	Organization
>;

/** The domain the account sells for, or null when the account never set one. */
export async function organizationDomain(
	env: DbEnv,
	organizationId: string,
	buildDb: DbFactory<OrganizationSelectConnection> = db,
): Promise<string | null> {
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.select()
			.from(organization)
			.where(eq(organization.id, organizationId)),
	);
	return rows[0]?.domain ?? null;
}

/** Every company domain already stored for this account, across all profiles, most recent first. Read through the cache-disabled binding; provider request limits are applied separately by the search adapter. */
export async function recentDomains(
	env: DbEnv,
	organizationId: string,
	buildDb: DbFactory<DomainsConnection> = db,
): Promise<string[]> {
	const rows = await withConnection(env, "direct", buildDb, (connection) =>
		connection
			.select({ domain: company.domain })
			.from(company)
			.where(eq(company.organizationId, organizationId))
			.orderBy(desc(company.foundAt)),
	);
	return rows.map((row) => row.domain);
}

/**
 * Records one round of a run: the plan the synthesizer wrote and what the
 * round kept and refused. Writing the same round twice is a no-op, so a
 * replayed step never doubles a row.
 */
export async function saveRound(
	env: DbEnv,
	row: NewRound,
	buildDb: DbFactory<RoundInsertConnection> = db,
): Promise<Round[]> {
	return withConnection(env, "cached", buildDb, (connection) =>
		connection
			.insert(round)
			.values([row])
			.onConflictDoNothing({ target: [round.runId, round.ordinal] })
			.returning(),
	);
}

export type RoundSelectConnection = SelectAllWhereConnection<
	typeof round,
	Round
>;

/** Every round a run recorded, oldest first. Read through the cached binding, since a finished run never changes. */
export async function roundsForRun(
	env: DbEnv,
	runId: string,
	buildDb: DbFactory<RoundSelectConnection> = db,
): Promise<Round[]> {
	return withConnection(env, "cached", buildDb, (connection) =>
		connection.select().from(round).where(eq(round.runId, runId)),
	);
}

export async function saveCompanies(
	env: DbEnv,
	rows: NewCompany[],
	buildDb: DbFactory<CompanyInsertConnection> = db,
): Promise<Company[]> {
	if (rows.length === 0) {
		return [];
	}
	const normalized = rows.map((row) => ({
		...row,
		domain: normalizeDomain(row.domain),
	}));
	return withConnection(env, "cached", buildDb, (connection) =>
		connection
			.insert(company)
			.values(normalized)
			.onConflictDoNothing({ target: [company.icpId, company.domain] })
			.returning(),
	);
}

export async function appendEvidence(
	env: DbEnv,
	rows: NewEvidence[],
	buildDb: DbFactory<EvidenceAppendConnection> = db,
): Promise<Evidence[]> {
	if (rows.length === 0) {
		return [];
	}
	return withConnection(env, "cached", buildDb, (connection) =>
		connection.insert(evidence).values(rows).returning(),
	);
}

export async function latestEvidence(
	env: DbEnv,
	subjectId: string,
	kind: string,
	buildDb: DbFactory<EvidenceReadConnection> = db,
): Promise<Evidence | undefined> {
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.select()
			.from(evidence)
			.where(and(eq(evidence.subjectId, subjectId), eq(evidence.kind, kind)))
			.orderBy(desc(evidence.seenAt))
			.limit(1),
	);
	return rows[0];
}

export {
	createIcp,
	loadIcp,
	type NewIcpInput,
	saveIcpProfile,
	saveOnboardedIcp,
} from "@/core/db/icp";
export {
	type PersonReadConnection,
	type PersonUpdateConnection,
	type PersonUpsertConnection,
	upsertPeople,
} from "@/core/db/people";
export {
	type CompanyCreateConnection,
	type CompanyOfRun,
	type CompanyRunConnection,
	type CompanyRunRow,
	companiesForRun,
	createCompanyRow,
	type RunCompanyInsertConnection,
	type RunCompanyLookupConnection,
	type RunCompanyPatch,
	type RunCompanyUpdateConnection,
	saveRunCompanies,
	updateRunCompany,
} from "@/core/db/run-companies";
export {
	assertUnderDailyCeiling,
	closeErroredRun,
	closeRun,
	findRun,
	openRun,
	organizationSpendToday,
	recordRunSpend,
	startOfUtcDay,
} from "@/core/db/runs";
