# The migration tool and the runtime point at different databases

Measured on 2026-08-27, before any schema work started.

## The mismatch

| Consumer | Reads | Points at |
|---|---|---|
| `drizzle.config.ts` | `DATABASE_URL` from `.env` | `postgres://app:***@localhost:5432/app` |
| The Worker at runtime | `localConnectionString` in `wrangler.jsonc` | `postgresql://postgres:postgres@localhost:5432/algo` |

The `app` database does not exist on this server. The databases are
`postgres`, `lahfir`, `flexile_development`, `bluefairy`, and `algo`. The four
real tables (`icp`, `company`, `person`, `evidence`) are in `algo`.

## What this breaks

Every `drizzle-kit` command fails at connect: `push`, `generate`, `pull`, and
`migrate` alike. This also explains the missing `drizzle/` directory — no
`drizzle-kit` run against the real database could ever have succeeded from
this configuration.

The danger is not the failure. The danger is a later edit that makes `app`
exist. Then `push` succeeds against an empty database, reports a clean diff,
and the real data in `algo` stays untouched and unmigrated while every tool
says the schema is current.

## The fix, before any schema change

Point `DATABASE_URL` at the same database the runtime uses, and keep the two
values in step from then on. Two consumers reading two different strings for
one database is the underlying defect; the wrong value is only the symptom.

`drizzle-kit` runs outside the Workers isolate and cannot read a Hyperdrive
binding, so it does need its own connection string. That is a reason for the
two settings to exist, never a reason for them to disagree.

## Check it before you migrate

Connect with the exact `DATABASE_URL` and list the tables. Seeing the four
expected tables is the only proof that the migration tool and the runtime
agree. A clean diff against an empty database looks identical to a clean diff
against a migrated one.
