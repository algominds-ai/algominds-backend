import type { SQL } from "drizzle-orm";
import { and, eq, isNull } from "drizzle-orm";
import { companyExaId } from "@/core/companies/candidates";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type {
	DbFactory,
	InsertConnection,
	SelectAllWhereConnection,
	UpdateWhereConnection,
} from "@/core/db/queries";
import { companyScopeForRun } from "@/core/db/run-scope";
import type {
	Company,
	NewCompany,
	NewRunCompany,
	Run,
	RunCompany,
} from "@/core/db/schema";
import { company, normalizeDomain, runCompany } from "@/core/db/schema";

export type CompanyRunRow = Pick<
	Company,
	"id" | "domain" | "name" | "data" | "linkedinUrl" | "icpId"
>;
export type CompanyOfRun = Pick<
	Company,
	"id" | "domain" | "name" | "linkedinUrl" | "icpId"
> & {
	exaId: string | null;
};
export interface CompanyRunConnection {
	select(columns: {
		id: typeof company.id;
		domain: typeof company.domain;
		name: typeof company.name;
		data: typeof company.data;
		linkedinUrl: typeof company.linkedinUrl;
		icpId: typeof company.icpId;
	}): {
		from(table: typeof company): {
			where(condition: SQL | undefined): {
				orderBy(...order: unknown[]): Promise<CompanyRunRow[]>;
			};
		};
	};
}
export type CompanyCreateConnection = InsertConnection<
	typeof company,
	NewCompany,
	Company
> &
	SelectAllWhereConnection<typeof company, Company>;
export type RunCompanyInsertConnection = InsertConnection<
	typeof runCompany,
	NewRunCompany,
	RunCompany
>;
export type RunCompanyPatch = Partial<
	Pick<
		NewRunCompany,
		| "companyId"
		| "identity"
		| "mode"
		| "buyerSource"
		| "spendDollars"
		| "clayRecords"
		| "peopleVerified"
		| "peopleRoster"
	>
>;
export type RunCompanyUpdateConnection = UpdateWhereConnection<
	typeof runCompany,
	RunCompanyPatch
>;

/**
 * Every company `run` covers, ordered by `found_at` then `id` so a
 * `maxCompanies` truncation of the result is reproducible. A companies run
 * covers its own company rows; a people run covers the companies its
 * `run_company` rows resolved to, the same scope `companyScopeForRun` gives
 * every other reader.
 */
export async function companiesForRun(
	env: DbEnv,
	run: Run,
	buildDb: DbFactory<CompanyRunConnection> = db,
): Promise<CompanyOfRun[]> {
	const condition = await companyScopeForRun(env, run);
	if (condition === null) return [];
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select({
			id: company.id,
			domain: company.domain,
			name: company.name,
			data: company.data,
			linkedinUrl: company.linkedinUrl,
			icpId: company.icpId,
		})
		.from(company)
		.where(condition)
		.orderBy(company.foundAt, company.id);
	return rows.map((row) => ({
		id: row.id,
		domain: row.domain,
		name: row.name,
		linkedinUrl: row.linkedinUrl,
		icpId: row.icpId,
		exaId: companyExaId(row.data),
	}));
}

function companyIdentityCondition(row: NewCompany): SQL | undefined {
	const icpId = row.icpId ?? null;
	const identity =
		icpId === null ? isNull(company.icpId) : eq(company.icpId, icpId);
	return and(
		eq(company.organizationId, row.organizationId),
		eq(company.domain, row.domain),
		identity,
	);
}

/**
 * Inserts one company row, or finds the row a concurrent request already
 * inserted under it. The insert names no conflict target, so either the
 * `(icp_id, domain)` unique pair or the `(organization_id, domain)` orphan
 * index can absorb the race; the row is then found by organization, domain
 * and profile, whichever index matched.
 */
export async function createCompanyRow(
	env: DbEnv,
	row: NewCompany,
	buildDb: DbFactory<CompanyCreateConnection> = db,
): Promise<Company> {
	const connection = buildDb(env, "cached");
	const normalized = { ...row, domain: normalizeDomain(row.domain) };
	const inserted = await connection
		.insert(company)
		.values(normalized)
		.onConflictDoNothing()
		.returning();
	const own = inserted[0];
	if (own) return own;
	const existing = await connection
		.select()
		.from(company)
		.where(companyIdentityCondition(normalized));
	const found = existing[0];
	if (!found) {
		throw new Error(
			`createCompanyRow: no row found for ${normalized.domain} after a no-op insert`,
		);
	}
	return found;
}

/** Inserts one row per requested domain of a people run, skipping a domain the run already recorded. */
export async function saveRunCompanies(
	env: DbEnv,
	rows: NewRunCompany[],
	buildDb: DbFactory<RunCompanyInsertConnection> = db,
): Promise<RunCompany[]> {
	if (rows.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	return connection
		.insert(runCompany)
		.values(rows)
		.onConflictDoNothing({ target: [runCompany.runId, runCompany.domain] })
		.returning();
}

/** Records the outcome of one requested domain: its identity, buyer mode, and spend so far. */
export async function updateRunCompany(
	env: DbEnv,
	id: string,
	patch: RunCompanyPatch,
	buildDb: DbFactory<RunCompanyUpdateConnection> = db,
): Promise<void> {
	const connection = buildDb(env, "cached");
	await connection.update(runCompany).set(patch).where(eq(runCompany.id, id));
}
