import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/core/db/client";
import type { Db, DbMode } from "@/core/db/client";
import {
	company,
	evidence,
	icp,
	normalizeDomain,
	person,
} from "@/core/db/schema";
import type {
	Company,
	Evidence,
	Icp,
	NewCompany,
	NewEvidence,
	NewPerson,
	Person,
} from "@/core/db/schema";

// Every query takes `env` and returns plain objects. No repository classes
// (CLAUDE.md). `buildDb` defaults to the real client builder; a test supplies
// a faithful fake in its place so the mode a query selects — the one thing
// R32/AE7 cares about — is provable without a live database or module
// mocking (biome bans `vi.mock`/`mock.module`).
export type DbFactory = (env: Env, mode: DbMode) => Db;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Exported so a test can prove the 90-day boundary (R7) without a live
// database: a company found 89 days ago must land on the "included" side of
// the cutoff, one found 91 days ago on the "excluded" side.
export function cutoffDate(days: number, now: Date = new Date()): Date {
	return new Date(now.getTime() - days * MS_PER_DAY);
}

export async function loadIcp(
	env: Env,
	icpId: string,
	buildDb: DbFactory = db,
): Promise<Icp | undefined> {
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select()
		.from(icp)
		.where(eq(icp.id, icpId))
		.limit(1);
	return rows[0];
}

// R32/KTD3/AE7: the dedupe read always uses the cache-disabled binding. A
// cached read here could re-deliver companies a write stored seconds earlier,
// because Hyperdrive does not invalidate its cache on write.
export async function recentDomains(
	env: Env,
	icpId: string,
	days: number,
	buildDb: DbFactory = db,
): Promise<string[]> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select({ domain: company.domain })
		.from(company)
		.where(and(eq(company.icpId, icpId), gte(company.foundAt, cutoffDate(days))));
	return rows.map((row) => row.domain);
}

// Normalizes each domain on write (plan step 5) so `recentDomains` and R42's
// grounding check never drift apart. The unique index on `(icp_id, domain)`
// makes a repeat insert of the same company a no-op rather than a duplicate
// row.
export async function saveCompanies(
	env: Env,
	rows: NewCompany[],
	buildDb: DbFactory = db,
): Promise<Company[]> {
	if (rows.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	const normalized = rows.map((row) => ({
		...row,
		domain: normalizeDomain(row.domain),
	}));
	return connection
		.insert(company)
		.values(normalized)
		.onConflictDoNothing({ target: [company.icpId, company.domain] })
		.returning();
}

// R11: people are deduplicated by LinkedIn URL, never by name plus company.
export async function savePeople(
	env: Env,
	rows: NewPerson[],
	buildDb: DbFactory = db,
): Promise<Person[]> {
	if (rows.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	return connection
		.insert(person)
		.values(rows)
		.onConflictDoNothing({ target: [person.linkedinUrl] })
		.returning();
}

// `evidence` is append-only (CLAUDE.md invariant, R18): this never updates or
// deletes an existing row, only adds new ones.
export async function appendEvidence(
	env: Env,
	rows: NewEvidence[],
	buildDb: DbFactory = db,
): Promise<Evidence[]> {
	if (rows.length === 0) {
		return [];
	}
	const connection = buildDb(env, "cached");
	return connection.insert(evidence).values(rows).returning();
}

export async function latestEvidence(
	env: Env,
	subjectId: string,
	kind: string,
	buildDb: DbFactory = db,
): Promise<Evidence | undefined> {
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select()
		.from(evidence)
		.where(and(eq(evidence.subjectId, subjectId), eq(evidence.kind, kind)))
		.orderBy(desc(evidence.seenAt))
		.limit(1);
	return rows[0];
}

// R20: `evidence.source` plus this one delete-by-person query is the whole
// data-deletion path. Both deletes run in one transaction so a failure never
// leaves an orphaned evidence row behind.
export async function deletePerson(
	env: Env,
	personId: string,
	buildDb: DbFactory = db,
): Promise<void> {
	const connection = buildDb(env, "cached");
	await connection.transaction(async (tx) => {
		await tx
			.delete(evidence)
			.where(
				and(eq(evidence.subjectType, "person"), eq(evidence.subjectId, personId)),
			);
		await tx.delete(person).where(eq(person.id, personId));
	});
}
