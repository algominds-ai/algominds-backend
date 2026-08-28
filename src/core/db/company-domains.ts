import { inArray } from "drizzle-orm";
import { companyExaId } from "@/core/companies/candidates";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory, SelectWhereConnection } from "@/core/db/queries";
import type { Company } from "@/core/db/schema";
import { company } from "@/core/db/schema";

export type CompanyDomainRow = Pick<
	Company,
	"id" | "domain" | "name" | "icpId" | "data"
>;
export type CompanyDomainMatch = Pick<
	Company,
	"id" | "domain" | "name" | "icpId"
> & { exaId: string | null };
export type CompanyDomainConnection = SelectWhereConnection<
	typeof company,
	{
		id: typeof company.id;
		domain: typeof company.domain;
		name: typeof company.name;
		icpId: typeof company.icpId;
		data: typeof company.data;
	},
	CompanyDomainRow
>;

function toCompanyDomainMatch(row: CompanyDomainRow): CompanyDomainMatch {
	return {
		id: row.id,
		domain: row.domain,
		name: row.name,
		icpId: row.icpId,
		exaId: companyExaId(row.data),
	};
}

/** The id, domain, name, icp id, and saved Exa organization id of every company whose domain is in `domains`. */
export async function companiesForDomains(
	env: DbEnv,
	domains: readonly string[],
	buildDb: DbFactory<CompanyDomainConnection> = db,
): Promise<CompanyDomainMatch[]> {
	if (domains.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select({
			id: company.id,
			domain: company.domain,
			name: company.name,
			icpId: company.icpId,
			data: company.data,
		})
		.from(company)
		.where(inArray(company.domain, [...domains]));
	return rows.map(toCompanyDomainMatch);
}
