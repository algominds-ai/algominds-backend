import type { SQL } from "drizzle-orm";
import { and, eq, isNull, or } from "drizzle-orm";
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
import { nameKey } from "@/core/people/dedupe";
import { PersonDataSchema } from "@/core/people/rows";

export type PersonUpdateConnection = UpdateWhereConnection<
	typeof person,
	Partial<Pick<NewPerson, "companyId" | "title" | "data" | "linkedinUrl">>
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

async function updateVerifiedRows(
	connection: PersonUpdateConnection,
	rows: NewPerson[],
): Promise<void> {
	for (const row of rows) {
		if (!isVerifiedRow(row)) continue;
		await connection
			.update(person)
			.set({ companyId: row.companyId, title: row.title, data: row.data })
			.where(personIdentityCondition(row));
	}
}

function matchRow(existing: Person[], row: NewPerson): Person | undefined {
	return existing.find(
		(found) =>
			found.organizationId === row.organizationId &&
			found.linkedinUrl === row.linkedinUrl,
	);
}

function companyCondition(row: NewPerson): SQL | undefined {
	return and(
		eq(person.organizationId, row.organizationId),
		eq(person.companyId, row.companyId),
	);
}

function findRenamedRow(existing: Person[], row: NewPerson): Person | null {
	if (!row.linkedinUrl) return null;
	if (matchRow(existing, row)) return null;
	const key = nameKey(row.name ?? null);
	if (!key) return null;
	return (
		existing.find(
			(found) =>
				found.organizationId === row.organizationId &&
				found.companyId === row.companyId &&
				found.linkedinUrl !== row.linkedinUrl &&
				nameKey(found.name) === key,
		) ?? null
	);
}

/**
 * Relinks a person to their new linkedin URL. A verified incoming row also
 * refreshes title and data; a roster row only corrects the URL. Returns the
 * rows that still need inserting.
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
			.set(
				isVerifiedRow(row)
					? { linkedinUrl: row.linkedinUrl, title: row.title, data: row.data }
					: { linkedinUrl: row.linkedinUrl },
			)
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

/**
 * Relinks a row whose company and name key match an existing person under a
 * changed linkedin URL, inserts every other new person row, then for every
 * incoming verified row updates the existing row's company, title and data
 * by `(organizationId, linkedinUrl)`. A roster row never overwrites a
 * verified one by that match. Returns the current row for every incoming
 * linkedin URL, inserted, relinked, or already on record.
 */
export async function upsertPeople(
	env: DbEnv,
	rows: NewPerson[],
	buildDb: DbFactory<PersonUpsertConnection> = db,
): Promise<Person[]> {
	if (rows.length === 0) return [];
	const existing = await withConnection(env, "direct", buildDb, (connection) =>
		connection
			.select()
			.from(person)
			.where(
				or(
					...rows.flatMap((row) => [
						personIdentityCondition(row),
						companyCondition(row),
					]),
				),
			),
	);
	await withConnection(env, "cached", buildDb, async (connection) => {
		const toInsert = await relinkRenamedRows(connection, existing, rows);
		if (toInsert.length > 0) {
			await connection
				.insert(person)
				.values(toInsert)
				.onConflictDoNothing({
					target: [person.organizationId, person.linkedinUrl],
				})
				.returning();
		}
		await updateVerifiedRows(connection, toInsert);
	});
	return withConnection(env, "direct", buildDb, (connection) =>
		readBackRows(connection, rows),
	);
}
