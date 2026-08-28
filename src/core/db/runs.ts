import { and, eq, gte } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type {
	AccountConnection,
	AccountSpendConnection,
	DbFactory,
	RunLookupConnection,
	RunOpenConnection,
	RunUpdateConnection,
} from "@/core/db/queries";
import type { Account, NewRun, Run } from "@/core/db/schema";
import { account, run } from "@/core/db/schema";

/** Finds the account for `domain`, creating it with `name` if it does not exist. */
export async function ensureAccount(
	env: DbEnv,
	name: string,
	domain: string,
	buildDb: DbFactory<AccountConnection> = db,
): Promise<Account> {
	const connection = buildDb(env, "cached");
	const inserted = await connection
		.insert(account)
		.values({ name, domain })
		.onConflictDoNothing({ target: [account.domain] })
		.returning();
	if (inserted[0]) return inserted[0];
	const rows = await connection
		.select()
		.from(account)
		.where(eq(account.domain, domain));
	const row = rows[0];
	if (!row) throw new Error(`ensureAccount: no account for domain ${domain}`);
	return row;
}

/** Opens a run, or returns the one already opened under this id. A retried step must not fail on the primary key it just wrote. */
export async function openRun(
	env: DbEnv,
	newRun: NewRun,
	buildDb: DbFactory<RunOpenConnection> = db,
): Promise<Run> {
	const connection = buildDb(env, "cached");
	const inserted = await connection
		.insert(run)
		.values(newRun)
		.onConflictDoNothing({ target: [run.id] })
		.returning();
	const created = inserted[0];
	if (created) return created;
	const existing = await buildDb(env, "direct")
		.select()
		.from(run)
		.where(eq(run.id, newRun.id))
		.limit(1);
	const row = existing[0];
	if (!row) throw new Error(`openRun: no run for id ${newRun.id}`);
	return row;
}

/**
 * The run row for `runId`, if one exists, read through the cache-disabled
 * binding so a start from earlier in this same request is never missed.
 */
export async function findRun(
	env: DbEnv,
	runId: string,
	buildDb: DbFactory<RunLookupConnection> = db,
): Promise<Run | undefined> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select()
		.from(run)
		.where(eq(run.id, runId))
		.limit(1);
	return rows[0];
}

/**
 * Records what a run has spent so far, without ending it. The daily ceiling
 * sums this column, so a run that dies before it closes still counts.
 */
export async function recordRunSpend(
	env: DbEnv,
	runId: string,
	costDollars: number,
	buildDb: DbFactory<RunUpdateConnection> = db,
): Promise<void> {
	const connection = buildDb(env, "cached");
	await connection.update(run).set({ costDollars }).where(eq(run.id, runId));
}

/** Records a run's terminal status and spend, and stamps `finished_at`. */
export async function closeRun(
	env: DbEnv,
	runId: string,
	outcome: Pick<NewRun, "status" | "costDollars">,
	buildDb: DbFactory<RunUpdateConnection> = db,
): Promise<void> {
	const connection = buildDb(env, "cached");
	await connection
		.update(run)
		.set({ ...outcome, finishedAt: new Date() })
		.where(eq(run.id, runId));
}

/** Midnight UTC on the day of `now` (defaults to the current time). */
export function startOfUtcDay(now: Date = new Date()): Date {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
}

/**
 * Sums an account's run spend since the start of the current UTC day, read
 * through the cache-disabled binding so a same-run write is never missed.
 */
export async function accountSpendToday(
	env: DbEnv,
	accountId: string,
	now: Date = new Date(),
	buildDb: DbFactory<AccountSpendConnection> = db,
): Promise<number> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select({ costDollars: run.costDollars })
		.from(run)
		.where(
			and(eq(run.accountId, accountId), gte(run.startedAt, startOfUtcDay(now))),
		);
	return rows.reduce((total, row) => total + row.costDollars, 0);
}
