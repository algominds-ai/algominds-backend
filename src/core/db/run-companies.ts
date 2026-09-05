import type { SQL } from "drizzle-orm";
import { and, eq, isNull } from "drizzle-orm";
import {
	companyExaId,
	companyWorkforceTotal,
} from "@/core/companies/candidates";
import type { DbEnv } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
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
	workforceTotal: number | null;
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
export type RunCompanyLookupConnection = SelectAllWhereConnection<
	typeof runCompany,
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
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection
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
			.orderBy(company.foundAt, company.id),
	);
	return rows.map((row) => ({
		id: row.id,
		domain: row.domain,
		name: row.name,
		linkedinUrl: row.linkedinUrl,
		icpId: row.icpId,
		exaId: companyExaId(row.data),
		workforceTotal: companyWorkforceTotal(row.data),
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
	const normalized = { ...row, domain: normalizeDomain(row.domain) };
	const inserted = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.insert(company)
			.values(normalized)
			.onConflictDoNothing()
			.returning(),
	);
	const own = inserted[0];
	if (own) return own;
	const existing = await withConnection(env, "direct", buildDb, (connection) =>
		connection
			.select()
			.from(company)
			.where(companyIdentityCondition(normalized)),
	);
	const found = existing[0];
	if (!found) {
		throw new Error(
			`createCompanyRow: no row found for ${normalized.domain} after a no-op insert`,
		);
	}
	return found;
}

async function existingRunCompany(
	env: DbEnv,
	row: NewRunCompany,
	buildDb: DbFactory<RunCompanyLookupConnection>,
): Promise<RunCompany> {
	const existing = await withConnection(env, "direct", buildDb, (connection) =>
		connection
			.select()
			.from(runCompany)
			.where(
				and(eq(runCompany.runId, row.runId), eq(runCompany.domain, row.domain)),
			),
	);
	const found = existing[0];
	if (!found) {
		throw new Error(
			`saveRunCompanies: no row found for ${row.domain} on run ${row.runId} after a no-op insert`,
		);
	}
	return found;
}

/** Inserts one row per requested domain of a people run, and re-selects a domain the run already recorded rather than treating the conflict as a miss. */
export async function saveRunCompanies(
	env: DbEnv,
	rows: NewRunCompany[],
	buildDb: DbFactory<
		RunCompanyInsertConnection & RunCompanyLookupConnection
	> = db,
): Promise<RunCompany[]> {
	if (rows.length === 0) {
		return [];
	}
	const inserted = await withConnection(env, "cached", buildDb, (connection) =>
		connection
			.insert(runCompany)
			.values(rows)
			.onConflictDoNothing({ target: [runCompany.runId, runCompany.domain] })
			.returning(),
	);
	if (inserted.length === rows.length) {
		return inserted;
	}
	const byDomain = new Map(inserted.map((row) => [row.domain, row]));
	return Promise.all(
		rows.map(
			(row) =>
				byDomain.get(row.domain) ?? existingRunCompany(env, row, buildDb),
		),
	);
}

/** Records the outcome of one requested domain: its identity, buyer mode, and spend so far. */
export async function updateRunCompany(
	env: DbEnv,
	id: string,
	patch: RunCompanyPatch,
	buildDb: DbFactory<RunCompanyUpdateConnection> = db,
): Promise<void> {
	await withConnection(env, "cached", buildDb, (connection) =>
		connection.update(runCompany).set(patch).where(eq(runCompany.id, id)),
	);
}
