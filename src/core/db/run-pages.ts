import { and, asc, eq, gt } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory, SelectOrderedConnection } from "@/core/db/queries";
import type { Company, Person } from "@/core/db/schema";
import { company, person } from "@/core/db/schema";

export type CompanyPageConnection = SelectOrderedConnection<
	typeof company,
	Company
>;

export interface PersonPageConnection {
	select(columns: { person: typeof person }): {
		from(table: typeof person): {
			innerJoin(
				table: typeof company,
				condition: unknown,
			): {
				where(condition: unknown): {
					orderBy(order: unknown): {
						limit(count: number): Promise<{ person: Person }[]>;
					};
				};
			};
		};
	};
}

/**
 * One page of the companies saved for a run, ordered by id ascending. An id
 * is unique and never changes, so `id > cursor` can neither skip nor repeat
 * a row already seen.
 */
export async function companiesPage(
	env: DbEnv,
	runId: string,
	page: { limit: number; cursor: string | undefined },
	buildDb: DbFactory<CompanyPageConnection> = db,
): Promise<{ rows: Company[]; nextCursor: string | null }> {
	const connection = buildDb(env, "cached");
	const condition = page.cursor
		? and(eq(company.runId, runId), gt(company.id, page.cursor))
		: eq(company.runId, runId);
	const rows = await connection
		.select()
		.from(company)
		.where(condition)
		.orderBy(asc(company.id))
		.limit(page.limit + 1);
	const kept = rows.slice(0, page.limit);
	return {
		rows: kept,
		nextCursor: rows.length > page.limit ? (kept.at(-1)?.id ?? null) : null,
	};
}

/**
 * One page of the people found for a run's companies, ordered by id
 * ascending. An id is unique and never changes, so `id > cursor` can
 * neither skip nor repeat a row already seen.
 */
export async function peoplePage(
	env: DbEnv,
	runId: string,
	page: { limit: number; cursor: string | undefined },
	buildDb: DbFactory<PersonPageConnection> = db,
): Promise<{ rows: Person[]; nextCursor: string | null }> {
	const connection = buildDb(env, "cached");
	const condition = page.cursor
		? and(eq(company.runId, runId), gt(person.id, page.cursor))
		: eq(company.runId, runId);
	const joined = await connection
		.select({ person })
		.from(person)
		.innerJoin(company, eq(person.companyId, company.id))
		.where(condition)
		.orderBy(asc(person.id))
		.limit(page.limit + 1);
	const rows = joined.map((row) => row.person);
	const kept = rows.slice(0, page.limit);
	return {
		rows: kept,
		nextCursor: rows.length > page.limit ? (kept.at(-1)?.id ?? null) : null,
	};
}
