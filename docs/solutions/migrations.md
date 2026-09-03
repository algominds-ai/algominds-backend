# How migrations work here, and the one way to break a deployed database

Two consumers read different configuration for the same database. `drizzle.config.ts`
reads `DATABASE_URL` from `.env`; the Worker at runtime reads `localConnectionString`
from the Hyperdrive bindings in `wrangler.jsonc`. They must name the same database.
They disagreed once, early on, and every `drizzle-kit` command failed at connect
until `.env` was corrected. Check both when a migration command cannot reach
anything.

## The rule: one baseline until the first production deploy

Before any database has run a migration, `drizzle/0000_baseline.sql` is the
whole schema and it is safe to delete and regenerate. Every schema change
before the first production deploy goes into that same file: edit
`src/core/db/schema.ts` and `src/core/db/auth-schema.ts`, delete
`drizzle/0000_baseline.sql` and `drizzle/meta/`, run `bun run db:generate`,
and rename the new file back to `drizzle/0000_baseline.sql` (fix the tag in
`drizzle/meta/_journal.json` to match). There is only ever one file and it
always matches the schema exactly, with no backfill statements, because
nothing has data to backfill yet.

**The moment a database runs the baseline — staging counts, not only
production — this licence expires.** From then on, a schema change is a new
numbered file, generated with `bun run db:generate` and never edited. Never
regenerate a migration a database has already applied.

## Why regenerating an applied migration breaks a database

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

This happened once, on the seller-context branch, back when the schema still
carried real data. `0000_baseline` was regenerated twice to absorb a new
column and a nullability change. Both changes were correct; the method was
not. The repair was to restore the baseline and its snapshot to the exact
bytes the deployed database had applied, then add the changes as `0001`.
That incident is the reason for the rule above.

## Applying a migration locally

Apply the baseline to an empty database, then any later migration, and inspect
the resulting shape with `\d` on every table. That proves both paths: a fresh
database and one that stopped at the previous migration.

```bash
createdb algo_fresh
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/algo_fresh bun run db:migrate
psql algo_fresh -c '\d "<table>"'   # repeat per table, compare against the schema
dropdb algo_fresh
```
