import { env as testEnv } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/core/db/client";

async function queryPlan(statement: ReturnType<typeof sql>): Promise<string> {
	const connection = db(testEnv, "direct");
	const plan = await connection.transaction(async (tx) => {
		await tx.execute(sql`set local enable_seqscan = off`);
		return tx.execute(sql`explain ${statement}`);
	});
	return plan.map((row) => String(row["QUERY PLAN"])).join("\n");
}

describe("the indexes the read paths depend on exist in the real schema", () => {
	it("reads a company's people through person_company_idx rather than scanning", async () => {
		const plan = await queryPlan(
			sql`select id from person where company_id = '00000000-0000-0000-0000-000000000000'`,
		);

		expect(plan).toContain("person_company_idx");
		expect(plan).not.toContain("Seq Scan");
	});

	it("reads an organization's runs newest first through run_organization_started_idx", async () => {
		const plan = await queryPlan(
			sql`select id from run where organization_id = '00000000-0000-0000-0000-000000000000' order by started_at desc`,
		);

		expect(plan).toContain("run_organization_started_idx");
	});

	it("reads an ICP's recent domains through an index rather than scanning", async () => {
		const plan = await queryPlan(
			sql`select domain from company where icp_id = '00000000-0000-0000-0000-000000000000' and found_at >= now() - interval '90 days'`,
		);

		expect(plan).toContain("Index");
		expect(plan).not.toContain("Seq Scan");
	});

	it("reads a run's companies through company_run_idx", async () => {
		const plan = await queryPlan(
			sql`select id from company where run_id = 'no-such-run'`,
		);

		expect(plan).toContain("company_run_idx");
	});
});
