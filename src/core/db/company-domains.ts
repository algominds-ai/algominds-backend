import type { SQL } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import {
	companyExaId,
	companyWorkforceTotal,
} from "@/core/companies/candidates";
import type { DbEnv } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type { DbFactory } from "@/core/db/queries";
import type { Company } from "@/core/db/schema";
import { company } from "@/core/db/schema";

export type CompanyDomainRow = Pick<
	Company,
	"id" | "domain" | "name" | "icpId" | "linkedinUrl" | "description" | "data"
>;
export type CompanyDomainMatch = Pick<
	CompanyDomainRow,
	"id" | "domain" | "name" | "icpId" | "linkedinUrl" | "description"
> & {
	workforceTotal: number | null;
	exaId: string | null;
};

export interface CompanyDomainConnection {
	select(): {
		from(table: typeof company): {
			where(condition: SQL | undefined): Promise<CompanyDomainRow[]>;
		};
	};
}

function toCompanyDomainMatch(row: CompanyDomainRow): CompanyDomainMatch {
	return {
		id: row.id,
		domain: row.domain,
		name: row.name,
		icpId: row.icpId,
		linkedinUrl: row.linkedinUrl,
		description: row.description,
		exaId: companyExaId(row.data),
		workforceTotal: companyWorkforceTotal(row.data),
	};
}

/** The id, domain, name, profile id, and LinkedIn URL of every company in `organizationId` whose domain is in `domains`, profiled or not. */
export async function companiesForDomains(
	env: DbEnv,
	domains: readonly string[],
	organizationId: string,
	buildDb: DbFactory<CompanyDomainConnection> = db,
): Promise<CompanyDomainMatch[]> {
	if (domains.length === 0) {
		return [];
	}
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.select()
			.from(company)
			.where(
				and(
					inArray(company.domain, [...domains]),
					eq(company.organizationId, organizationId),
				),
			),
	);
	return rows.map((row) => toCompanyDomainMatch(row));
}
