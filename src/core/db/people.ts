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
import { PersonDataSchema } from "@/core/people/rows";

export type PersonUpdateConnection = UpdateWhereConnection<
	typeof person,
	Partial<Pick<NewPerson, "companyId" | "title" | "data">>
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
 * Inserts new person rows, then for every incoming verified row updates the
 * existing row's company, title and data by `(organizationId, linkedinUrl)`.
 * A roster row never overwrites anything. Returns the current row for every
 * incoming linkedin URL, inserted or already on record.
 */
export async function upsertPeople(
	env: DbEnv,
	rows: NewPerson[],
	buildDb: DbFactory<PersonUpsertConnection> = db,
): Promise<Person[]> {
	if (rows.length === 0) return [];
	await withConnection(env, "cached", buildDb, async (connection) => {
		await connection
			.insert(person)
			.values(rows)
			.onConflictDoNothing({
				target: [person.organizationId, person.linkedinUrl],
			})
			.returning();
		await updateVerifiedRows(connection, rows);
	});
	return withConnection(env, "direct", buildDb, (connection) =>
		readBackRows(connection, rows),
	);
}
