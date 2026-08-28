import { inArray } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory, SelectWhereConnection } from "@/core/db/queries";
import type { Company } from "@/core/db/schema";
import { company } from "@/core/db/schema";

export type CompanyDomainMatch = Pick<
	Company,
	"id" | "domain" | "name" | "icpId"
>;
export type CompanyDomainConnection = SelectWhereConnection<
	typeof company,
	{
		id: typeof company.id;
		domain: typeof company.domain;
		name: typeof company.name;
		icpId: typeof company.icpId;
	},
	CompanyDomainMatch
>;

/** The id, domain, name, and icp id of every company whose domain is in `domains`. */
export async function companiesForDomains(
	env: DbEnv,
	domains: readonly string[],
	buildDb: DbFactory<CompanyDomainConnection> = db,
): Promise<CompanyDomainMatch[]> {
	if (domains.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	return connection
		.select({
			id: company.id,
			domain: company.domain,
			name: company.name,
			icpId: company.icpId,
		})
		.from(company)
		.where(inArray(company.domain, [...domains]));
}
