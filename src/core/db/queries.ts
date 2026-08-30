import type { SQL } from "drizzle-orm";
import { and, desc, eq, gte } from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import { companyExaId } from "@/core/companies/candidates";
import { organization } from "@/core/db/auth-schema";
import type { DbEnv, DbMode } from "@/core/db/client";
import { db } from "@/core/db/client";
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
	icp,
	normalizeDomain,
	person,
	round,
	type run,
} from "@/core/db/schema";
import type { IcpDoc, IcpSeller } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";

export type Organization = typeof organization.$inferSelect;
export type NewOrganization = typeof organization.$inferInsert;

export type DbFactory<TConnection> = (env: DbEnv, mode: DbMode) => TConnection;

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

interface SelectAllWhereConnection<TTable, TRow> {
	select(): {
		from(table: TTable): {
			where(condition: SQL | undefined): Promise<TRow[]>;
		};
	};
}

interface UpdateWhereConnection<TTable, TValues> {
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
		where(condition: SQL | undefined): Promise<never[]>;
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
export type CompanyRunRow = Pick<Company, "id" | "domain" | "name" | "data">;
export type RunCompany = Pick<Company, "id" | "domain" | "name"> & {
	exaId: string | null;
};
export type CompanyRunConnection = SelectWhereConnection<
	typeof company,
	{
		id: typeof company.id;
		domain: typeof company.domain;
		name: typeof company.name;
		data: typeof company.data;
	},
	CompanyRunRow
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

export type NewIcpInput = Pick<NewIcp, "domain" | "organizationId"> & {
	description: string;
	seller?: IcpSeller | null;
};

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
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select()
		.from(organization)
		.where(eq(organization.id, organizationId));
	return rows[0]?.domain ?? null;
}

/** Stores the whole ideal customer profile document, description and seller block alike. */
export async function createIcp(
	env: DbEnv,
	input: NewIcpInput,
	buildDb: DbFactory<IcpInsertConnection> = db,
): Promise<Icp> {
	const connection = buildDb(env, "cached");
	const doc: IcpDoc = IcpDocSchema.parse({
		description: input.description,
		seller: input.seller ?? null,
	});
	const rows = await connection
		.insert(icp)
		.values({
			domain: input.domain,
			organizationId: input.organizationId,
			doc,
		})
		.returning();
	const row = rows[0];
	if (!row) throw new Error("createIcp: insert returned no row");
	return row;
}

/** The id, domain, name, and saved Exa organization id of every company found in run `runId`. */
export async function companiesForRun(
	env: DbEnv,
	runId: string,
	buildDb: DbFactory<CompanyRunConnection> = db,
): Promise<RunCompany[]> {
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select({
			id: company.id,
			domain: company.domain,
			name: company.name,
			data: company.data,
		})
		.from(company)
		.where(eq(company.runId, runId));
	return rows.map((row) => ({
		id: row.id,
		domain: row.domain,
		name: row.name,
		exaId: companyExaId(row.data),
	}));
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
	const connection = buildDb(env, "cached");
	return connection
		.insert(round)
		.values([row])
		.onConflictDoNothing({ target: [round.runId, round.ordinal] })
		.returning();
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
	const connection = buildDb(env, "cached");
	return connection.select().from(round).where(eq(round.runId, runId));
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
		.onConflictDoNothing({
			target: [person.organizationId, person.linkedinUrl],
		})
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

export {
	assertUnderDailyCeiling,
	closeRun,
	findRun,
	openRun,
	organizationSpendToday,
	recordRunSpend,
	startOfUtcDay,
} from "@/core/db/runs";
