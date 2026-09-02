import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory } from "@/core/db/queries";
import type { Run } from "@/core/db/schema";
import { company, runCompany } from "@/core/db/schema";

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
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select({ companyId: runCompany.companyId })
		.from(runCompany)
		.where(and(eq(runCompany.runId, run.id), isNotNull(runCompany.companyId)));
	const companyIds = rows
		.map((row) => row.companyId)
		.filter((id): id is string => id !== null);
	return inArray(company.id, companyIds);
}
