import type { SQL } from "drizzle-orm";
import { and, eq, gte } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory } from "@/core/db/queries";
import { cutoffDate } from "@/core/db/queries";
import type { Company } from "@/core/db/schema";
import { company, evidence, person, run } from "@/core/db/schema";

const PERSON_FOUND_EVIDENCE_KIND = "fullName";

export interface KnownPeopleConnection {
	select(columns: { company: typeof company }): {
		from(table: typeof company): {
			innerJoin(
				table: typeof run,
				condition: SQL | undefined,
			): {
				innerJoin(
					table: typeof person,
					condition: SQL | undefined,
				): {
					innerJoin(
						table: typeof evidence,
						condition: SQL | undefined,
					): {
						where(condition: SQL | undefined): Promise<{ company: Company }[]>;
					};
				};
			};
		};
	};
}

export type KnownPeopleWindow = { days: number; now?: Date };

/**
 * Domains, within `organizationId`, whose people were found in the trailing
 * `window.days` days. Reads through the cache-disabled binding, because a
 * person written earlier in this same run must be visible.
 */
export async function knownPeopleDomains(
	env: DbEnv,
	organizationId: string,
	window: KnownPeopleWindow,
	buildDb: DbFactory<KnownPeopleConnection> = db,
): Promise<string[]> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select({ company })
		.from(company)
		.innerJoin(run, eq(company.runId, run.id))
		.innerJoin(person, eq(person.companyId, company.id))
		.innerJoin(evidence, eq(evidence.subjectId, person.id))
		.where(
			and(
				eq(run.organizationId, organizationId),
				eq(evidence.subjectType, "person"),
				eq(evidence.kind, PERSON_FOUND_EVIDENCE_KIND),
				gte(evidence.seenAt, cutoffDate(window.days, window.now)),
			),
		);
	return rows.map((row) => row.company.domain);
}
