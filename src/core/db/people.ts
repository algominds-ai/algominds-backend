import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { toBatches } from "@/core/batches";
import type { DbEnv } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type {
	DbFactory,
	PersonInsertConnection,
	SelectAllWhereConnection,
	UpdateWhereConnection,
} from "@/core/db/queries";
import type { NewPerson, Person } from "@/core/db/schema";
import { person } from "@/core/db/schema";
import { PersonDataSchema } from "@/core/people/rows";

export type PersonUpdateConnection = UpdateWhereConnection<
	typeof person,
	Partial<
		Pick<NewPerson, "companyId" | "name" | "title" | "data" | "linkedinUrl">
	>
>;
export type PersonReadConnection = SelectAllWhereConnection<
	typeof person,
	Person
>;
export type PersonUpsertConnection = PersonInsertConnection &
	PersonUpdateConnection &
	PersonReadConnection;

function isVerifiedRow(row: NewPerson): boolean {
	return PersonDataSchema.safeParse(row.data).data?.status === "verified";
}

function personIdentityCondition(row: NewPerson): SQL | undefined {
	const linkedinUrl = row.linkedinUrl ?? null;
	const identity =
		linkedinUrl === null
			? isNull(person.linkedinUrl)
			: eq(person.linkedinUrl, linkedinUrl);
	return and(eq(person.organizationId, row.organizationId), identity);
}

async function refreshPeopleRows(
	connection: PersonUpdateConnection,
	rows: NewPerson[],
): Promise<void> {
	for (const row of rows) {
		const status = PersonDataSchema.safeParse(row.data).data?.status;
		if (status !== "verified" && status !== "pending") continue;
		const verified = status === "verified";
		await connection
			.update(person)
			.set({
				companyId: row.companyId,
				name: row.name,
				title: row.title,
				data: row.data,
			})
			.where(
				and(
					personIdentityCondition(row),
					verified ? undefined : sql`${person.data}->>'status' <> 'verified'`,
				),
			);
	}
}

function matchRow(existing: Person[], row: NewPerson): Person | undefined {
	return existing.find(
		(found) =>
			found.organizationId === row.organizationId &&
			found.linkedinUrl === row.linkedinUrl,
	);
}

function aliasCondition(row: NewPerson): SQL | undefined {
	const aliases = PersonDataSchema.safeParse(row.data).data?.aliases ?? [];
	if (!isVerifiedRow(row) || aliases.length === 0) return undefined;
	return and(
		eq(person.organizationId, row.organizationId),
		eq(person.companyId, row.companyId),
		inArray(person.linkedinUrl, aliases),
	);
}

function findRenamedRow(existing: Person[], row: NewPerson): Person | null {
	if (!row.linkedinUrl || !isVerifiedRow(row)) return null;
	if (matchRow(existing, row)) return null;
	const aliases = PersonDataSchema.safeParse(row.data).data?.aliases ?? [];
	const matches = existing.filter(
		(found) =>
			found.organizationId === row.organizationId &&
			found.companyId === row.companyId &&
			found.linkedinUrl !== null &&
			aliases.includes(found.linkedinUrl),
	);
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Relinks only a source-proven profile alias and refreshes verified fields.
 * Returns the rows that still need inserting.
 */
async function relinkRenamedRows(
	connection: PersonUpdateConnection,
	existing: Person[],
	rows: NewPerson[],
): Promise<NewPerson[]> {
	const toInsert: NewPerson[] = [];
	for (const row of rows) {
		const renamed = findRenamedRow(existing, row);
		if (!renamed) {
			toInsert.push(row);
			continue;
		}
		await connection
			.update(person)
			.set({
				linkedinUrl: row.linkedinUrl,
				name: row.name,
				title: row.title,
				data: row.data,
			})
			.where(eq(person.id, renamed.id));
	}
	return toInsert;
}

async function readBackRows(
	connection: PersonReadConnection,
	rows: NewPerson[],
): Promise<Person[]> {
	const existing = await connection
		.select()
		.from(person)
		.where(or(...rows.map(personIdentityCondition)));
	return rows
		.map((row) => matchRow(existing, row))
		.filter((found): found is Person => found !== undefined);
}

async function existingPeople(
	env: DbEnv,
	rows: NewPerson[],
	buildDb: DbFactory<PersonUpsertConnection>,
): Promise<Person[]> {
	return withConnection(env, "direct", buildDb, (connection) =>
		connection
			.select()
			.from(person)
			.where(
				or(
					...rows.flatMap((row) => [
						personIdentityCondition(row),
						aliasCondition(row),
					]),
				),
			),
	);
}

/** Persists people in bounded SQL batches, preserving input order, verified fields and source-proven profile aliases. */
export async function upsertPeople(
	env: DbEnv,
	rows: NewPerson[],
	buildDb: DbFactory<PersonUpsertConnection> = db,
): Promise<Person[]> {
	if (rows.length === 0) return [];
	const batches = toBatches(rows, 1000);
	const existing = new Map<string, Person>();
	for (const batch of batches)
		for (const row of await existingPeople(env, batch, buildDb))
			existing.set(row.id, row);
	const originalRows = [...existing.values()];
	await withConnection(env, "cached", buildDb, async (connection) => {
		const toInsert: NewPerson[] = [];
		for (const batch of batches)
			toInsert.push(
				...(await relinkRenamedRows(connection, originalRows, batch)),
			);
		for (const batch of toBatches(toInsert, 1000))
			await connection
				.insert(person)
				.values(batch)
				.onConflictDoNothing({
					target: [person.organizationId, person.linkedinUrl],
				})
				.returning();
		await refreshPeopleRows(connection, toInsert);
	});
	const saved: Person[] = [];
	for (const batch of batches)
		saved.push(
			...(await withConnection(env, "direct", buildDb, (connection) =>
				readBackRows(connection, batch),
			)),
		);
	return saved;
}
