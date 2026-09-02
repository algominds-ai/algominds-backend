import type { SQL } from "drizzle-orm";
import { and, asc, eq, gt } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type { DbFactory, SelectOrderedConnection } from "@/core/db/queries";
import { companyScopeForRun } from "@/core/db/run-scope";
import type { Company, Person, Run, RunCompany } from "@/core/db/schema";
import { company, person, runCompany } from "@/core/db/schema";

export type CompanyPageConnection = SelectOrderedConnection<
	typeof company,
	Company
>;

export type RunCompanyPageRow = RunCompany & { company: Company | null };
export type CompanyPageRow = Company | RunCompanyPageRow;

export interface PersonPageConnection {
	select(columns: { person: typeof person }): {
		from(table: typeof person): {
			innerJoin(
				table: typeof company,
				condition: SQL | undefined,
			): {
				where(condition: SQL | undefined): {
					orderBy(order: SQL): {
						limit(count: number): Promise<{ person: Person }[]>;
					};
				};
			};
		};
	};
}

/**
 * One page of a people run's requested domains, ordered by `run_company.id`
 * ascending, left-joined to the company each one resolved to. An unresolved
 * domain carries a null company.
 */
async function peopleRunCompaniesPage(
	env: DbEnv,
	run: Run,
	page: { limit: number; cursor: string | undefined },
): Promise<{ rows: CompanyPageRow[]; nextCursor: string | null }> {
	const condition = page.cursor
		? and(eq(runCompany.runId, run.id), gt(runCompany.id, page.cursor))
		: eq(runCompany.runId, run.id);
	const rows = await withConnection(env, "cached", db, (connection) =>
		connection
			.select({
				id: runCompany.id,
				runId: runCompany.runId,
				domain: runCompany.domain,
				companyId: runCompany.companyId,
				identity: runCompany.identity,
				mode: runCompany.mode,
				buyerSource: runCompany.buyerSource,
				spendDollars: runCompany.spendDollars,
				clayRecords: runCompany.clayRecords,
				peopleVerified: runCompany.peopleVerified,
				peopleRoster: runCompany.peopleRoster,
				company,
			})
			.from(runCompany)
			.leftJoin(company, eq(runCompany.companyId, company.id))
			.where(condition)
			.orderBy(asc(runCompany.id))
			.limit(page.limit + 1),
	);
	const kept = rows.slice(0, page.limit);
	return {
		rows: kept,
		nextCursor: rows.length > page.limit ? (kept.at(-1)?.id ?? null) : null,
	};
}

/**
 * One page of the companies saved for a run, ordered by id ascending. A
 * companies run pages its own company rows; a people run pages its
 * `run_company` rows instead, so an unresolved domain stays visible. An id is
 * unique and never changes, so `id > cursor` can neither skip nor repeat a
 * row already seen.
 */
export async function companiesPage(
	env: DbEnv,
	run: Run,
	page: { limit: number; cursor: string | undefined },
	buildDb: DbFactory<CompanyPageConnection> = db,
): Promise<{ rows: CompanyPageRow[]; nextCursor: string | null }> {
	if (run.capability === "people") {
		return peopleRunCompaniesPage(env, run, page);
	}
	const condition = page.cursor
		? and(eq(company.runId, run.id), gt(company.id, page.cursor))
		: eq(company.runId, run.id);
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.select()
			.from(company)
			.where(condition)
			.orderBy(asc(company.id))
			.limit(page.limit + 1),
	);
	const kept = rows.slice(0, page.limit);
	return {
		rows: kept,
		nextCursor: rows.length > page.limit ? (kept.at(-1)?.id ?? null) : null,
	};
}

/**
 * One page of the people found for the companies a run covers, ordered by id
 * ascending. A people run covers its resolved `run_company` rows, since a
 * person carries no run id of its own. An id is unique and never changes, so
 * `id > cursor` can neither skip nor repeat a row already seen.
 */
export async function peoplePage(
	env: DbEnv,
	run: Run,
	page: { limit: number; cursor: string | undefined },
	buildDb: DbFactory<PersonPageConnection> = db,
): Promise<{ rows: Person[]; nextCursor: string | null }> {
	const scope = await companyScopeForRun(env, run);
	if (scope === null) return { rows: [], nextCursor: null };
	const condition = page.cursor
		? and(scope, gt(person.id, page.cursor))
		: scope;
	const joined = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.select({ person })
			.from(person)
			.innerJoin(company, eq(person.companyId, company.id))
			.where(condition)
			.orderBy(asc(person.id))
			.limit(page.limit + 1),
	);
	const rows = joined.map((row) => row.person);
	const kept = rows.slice(0, page.limit);
	return {
		rows: kept,
		nextCursor: rows.length > page.limit ? (kept.at(-1)?.id ?? null) : null,
	};
}
