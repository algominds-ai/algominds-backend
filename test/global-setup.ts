import postgres from "postgres";

const TEST_DATABASE_URL =
	"postgresql://postgres:postgres@localhost:5432/algo_test";

/**
 * Confirms `algo_test` exists and is reachable before any spec runs, so a
 * missing database fails once with a fix instead of once per test file.
 */
export default async function setup() {
	const sql = postgres(TEST_DATABASE_URL, { max: 1 });
	try {
		await sql`select 1`;
	} catch (error) {
		throw new Error(
			"algo_test database is missing or unreachable. run: bun run db:test:reset",
			{ cause: error },
		);
	} finally {
		await sql.end();
	}
}
