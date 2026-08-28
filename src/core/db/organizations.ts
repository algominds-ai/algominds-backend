import { eq } from "drizzle-orm";
import { organization } from "@/core/db/auth-schema";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type {
	DbFactory,
	Organization,
	OrganizationConnection,
} from "@/core/db/queries";

/**
 * The organization for `slug`, creating one with `name` if none exists yet.
 * Mirrors `openRun`: an insert that loses the race falls back to a read of
 * the row the winner just wrote, through the cache-disabled binding.
 */
export async function organizationForSlug(
	env: DbEnv,
	slug: string,
	name: string,
	buildDb: DbFactory<OrganizationConnection> = db,
): Promise<Organization> {
	const connection = buildDb(env, "cached");
	const inserted = await connection
		.insert(organization)
		.values({ id: crypto.randomUUID(), slug, name, createdAt: new Date() })
		.onConflictDoNothing({ target: [organization.slug] })
		.returning();
	const created = inserted[0];
	if (created) return created;
	const existing = await buildDb(env, "direct")
		.select()
		.from(organization)
		.where(eq(organization.slug, slug))
		.limit(1);
	const row = existing[0];
	if (!row) {
		throw new Error(`organizationForSlug: no organization for slug ${slug}`);
	}
	return row;
}
