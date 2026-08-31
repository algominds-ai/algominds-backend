# How migrations work here, and the one way to break a deployed database

Two consumers read different configuration for the same database. `drizzle.config.ts`
reads `DATABASE_URL` from `.env`; the Worker at runtime reads `localConnectionString`
from the Hyperdrive bindings in `wrangler.jsonc`. They must name the same database.
They disagreed once, early on, and every `drizzle-kit` command failed at connect
until `.env` was corrected. Check both when a migration command cannot reach
anything.

## Never regenerate a migration a database has applied

`drizzle-kit generate` writes the SQL, a snapshot, and a journal entry carrying a
`when` timestamp. The migrator runs every migration whose `when` is greater than the
last `created_at` the target database recorded:

```js
if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
  for (const stmt of migration.sql) await tx.execute(sql.raw(stmt));
}
```

So regenerating an existing migration in place — same tag, new timestamp, new
contents — makes any database that already applied it run the file again. For a
baseline that means `CREATE TABLE` against tables that exist, and the deploy stops
there. A local database recreated from scratch never shows this, because it has no
recorded `created_at` to compare against. That is what makes it easy to ship.

This happened on the seller-context branch. `0000_baseline` was regenerated twice to
absorb a new column and a nullability change. Both changes were correct; the method
was not. The repair was to restore the baseline and its snapshot to the exact bytes
the deployed database had applied, then add the changes as `0001`:

```sql
ALTER TABLE "run" ALTER COLUMN "icp_id" DROP NOT NULL;
ALTER TABLE "company" ADD COLUMN "industry" text;
```

## The rule

A migration is append-only once any database has run it. Greenfield licence to drop
and recreate the baseline expires the moment a shared database exists — and "shared"
includes staging, not just production.

## Verifying a migration change

Apply the baseline to an empty database, then the new migration, and inspect the
resulting shape. That proves both paths: a fresh database and one that stopped at the
previous migration.
