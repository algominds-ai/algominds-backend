import { and, asc, eq, gt } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory, SelectOrderedConnection } from "@/core/db/queries";
import type { Company, Person } from "@/core/db/schema";
import { company, person } from "@/core/db/schema";

export type Page<TRow> = { rows: TRow[]; nextCursor: string | null };

export type PageRequest = { limit: number; cursor: string | undefined };

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

/** Trims a limit-plus-one read to `limit` rows, reporting the last row's id as the next cursor only when a row was left over. */
function toPage<TRow extends { id: string }>(
	rows: readonly TRow[],
	limit: number,
): Page<TRow> {
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return {
		rows: page,
		nextCursor: rows.length > limit ? (last?.id ?? null) : null,
	};
}

/**
 * One page of the companies saved for a run, ordered by id. A company id is
 * unique and never changes, so `id > cursor` can neither skip nor repeat a
 * row a caller has already seen.
 */
export async function companiesPage(
	env: DbEnv,
	runId: string,
	page: PageRequest,
	buildDb: DbFactory<CompanyPageConnection> = db,
): Promise<Page<Company>> {
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
	return toPage(rows, page.limit);
}

/**
 * One page of the people found for a run's companies, ordered by id. A
 * person id is unique and never changes, so `id > cursor` can neither skip
 * nor repeat a row a caller has already seen.
 */
export async function peoplePage(
	env: DbEnv,
	runId: string,
	page: PageRequest,
	buildDb: DbFactory<PersonPageConnection> = db,
): Promise<Page<Person>> {
	const connection = buildDb(env, "cached");
	const condition = page.cursor
		? and(eq(company.runId, runId), gt(person.id, page.cursor))
		: eq(company.runId, runId);
	const rows = await connection
		.select({ person })
		.from(person)
		.innerJoin(company, eq(person.companyId, company.id))
		.where(condition)
		.orderBy(asc(person.id))
		.limit(page.limit + 1);
	return toPage(
		rows.map((row) => row.person),
		page.limit,
	);
}
