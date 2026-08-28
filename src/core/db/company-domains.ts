import type { SQL } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import { companyExaId } from "@/core/companies/candidates";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory } from "@/core/db/queries";
import type { Company } from "@/core/db/schema";
import { company, icp } from "@/core/db/schema";

export type CompanyDomainRow = Pick<
	Company,
	"id" | "domain" | "name" | "icpId" | "data"
>;
export type CompanyDomainMatch = Pick<
	Company,
	"id" | "domain" | "name" | "icpId"
> & { exaId: string | null };

export interface CompanyDomainConnection {
	select(columns: { company: typeof company }): {
		from(table: typeof company): {
			innerJoin(
				table: typeof icp,
				condition: SQL | undefined,
			): {
				where(condition: SQL | undefined): Promise<{ company: Company }[]>;
			};
		};
	};
}

function toCompanyDomainMatch(row: CompanyDomainRow): CompanyDomainMatch {
	return {
		id: row.id,
		domain: row.domain,
		name: row.name,
		icpId: row.icpId,
		exaId: companyExaId(row.data),
	};
}

/** The id, domain, name, icp id, and saved Exa organization id of every company in `organizationId` whose domain is in `domains`. */
export async function companiesForDomains(
	env: DbEnv,
	domains: readonly string[],
	organizationId: string,
	buildDb: DbFactory<CompanyDomainConnection> = db,
): Promise<CompanyDomainMatch[]> {
	if (domains.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select({ company })
		.from(company)
		.innerJoin(icp, eq(company.icpId, icp.id))
		.where(
			and(
				inArray(company.domain, [...domains]),
				eq(icp.organizationId, organizationId),
			),
		);
	return rows.map((row) => toCompanyDomainMatch(row.company));
}
