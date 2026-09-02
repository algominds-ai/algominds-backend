import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type { DbFactory } from "@/core/db/queries";
import type { Run } from "@/core/db/schema";
import { company, person, runCompany } from "@/core/db/schema";
import type { PersonStatus } from "@/core/people/rows";

export interface RunCompanyIdsConnection {
	select(columns: { companyId: typeof runCompany.companyId }): {
		from(table: typeof runCompany): {
			where(
				condition: SQL | undefined,
			): Promise<{ companyId: string | null }[]>;
		};
	};
}

/**
 * The condition selecting the companies a run covers, or null when the
 * capability covers none. A companies run owns its rows directly; a people
 * run covers the companies its own `run_company` rows resolved to, since a
 * person carries no run id of its own and a people run may name no profile.
 * Onboarding and enrich cover none: onboarding finds no companies, and an
 * enrich run reads the run it was asked to enrich. Never `undefined`, which
 * drizzle reads as no condition at all and would return every row.
 */
export async function companyScopeForRun(
	env: DbEnv,
	run: Run,
	buildDb: DbFactory<RunCompanyIdsConnection> = db,
): Promise<SQL | null> {
	if (run.capability === "companies") return eq(company.runId, run.id);
	if (run.capability !== "people") return null;
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.select({ companyId: runCompany.companyId })
			.from(runCompany)
			.where(
				and(eq(runCompany.runId, run.id), isNotNull(runCompany.companyId)),
			),
	);
	const companyIds = rows
		.map((row) => row.companyId)
		.filter((id): id is string => id !== null);
	return inArray(company.id, companyIds);
}

export interface RunCompanyScopeConnection {
	select(columns: {
		companyId: typeof runCompany.companyId;
		mode: typeof runCompany.mode;
	}): {
		from(table: typeof runCompany): {
			where(
				condition: SQL | undefined,
			): Promise<{ companyId: string | null; mode: string | null }[]>;
		};
	};
}

const PERSON_STATUS_COLUMN = sql`${person.data}->>'status'`;

const STATUSES_STORED_BY_MODE: Record<string, readonly PersonStatus[]> = {
	target: ["verified"],
	profile: ["verified"],
	roster: ["roster", "verified"],
};

function statusScopeForMode(mode: string | null): SQL {
	const allowed = mode !== null ? STATUSES_STORED_BY_MODE[mode] : undefined;
	if (allowed === undefined) return isNotNull(PERSON_STATUS_COLUMN);
	return (
		and(
			isNotNull(PERSON_STATUS_COLUMN),
			inArray(PERSON_STATUS_COLUMN, [...allowed]),
		) ?? isNotNull(PERSON_STATUS_COLUMN)
	);
}

/**
 * The condition selecting the people a people run's own pipeline stored, read
 * from its `run_company` rows in one query: the companies it resolved to,
 * narrowed to the statuses that run's mode ever writes (`target` and
 * `profile` write only `verified`; `roster` writes `roster` or `verified`).
 */
export async function peopleStoredScope(
	env: DbEnv,
	runId: string,
	buildDb: DbFactory<RunCompanyScopeConnection> = db,
): Promise<SQL> {
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.select({ companyId: runCompany.companyId, mode: runCompany.mode })
			.from(runCompany)
			.where(eq(runCompany.runId, runId)),
	);
	const companyIds = rows
		.map((row) => row.companyId)
		.filter((id): id is string => id !== null);
	const mode = rows.find((row) => row.mode !== null)?.mode ?? null;
	const companyScope = inArray(company.id, companyIds);
	return and(companyScope, statusScopeForMode(mode)) ?? companyScope;
}
