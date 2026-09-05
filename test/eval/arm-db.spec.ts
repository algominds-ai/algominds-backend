import { env as testEnv } from "cloudflare:workers";
import { armDatabaseName, armDatabaseUrl, seedProfilesAt } from "@eval/arm-db";
import { PROFILES } from "@eval/profiles";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

describe("armDatabaseName", () => {
	it("prefixes the arm name so it cannot collide with algo or algo_test", () => {
		expect(armDatabaseName("baseline")).toBe("eval_baseline");
	});
});

describe("armDatabaseUrl", () => {
	it("builds a local connection string for the arm's own database", () => {
		expect(armDatabaseUrl("baseline")).toBe(
			"postgresql://postgres:postgres@localhost:5432/eval_baseline",
		);
	});
});

describe("seedProfilesAt", () => {
	const organizationIds: string[] = [];
	const icpIds: string[] = [];

	afterAll(async () => {
		const sql = postgres(testEnv.HYPERDRIVE_DIRECT.connectionString, {
			max: 1,
		});
		try {
			if (icpIds.length > 0) {
				await sql`delete from icp where id = any(${icpIds})`;
			}
			if (organizationIds.length > 0) {
				await sql`delete from apikey where reference_id = any(${organizationIds})`;
				await sql`delete from member where organization_id = any(${organizationIds})`;
				await sql`delete from organization where id = any(${organizationIds})`;
			}
			await sql`delete from "user" where email like '%@eval.internal'`;
		} finally {
			await sql.end();
		}
	});

	it("seeds one organization, api key and icp row per profile per trial, with a fresh icp id for every trial", async () => {
		const seeded = await seedProfilesAt(
			testEnv.HYPERDRIVE_DIRECT.connectionString,
			2,
		);
		for (const trial of seeded) {
			organizationIds.push(trial.organizationId);
			icpIds.push(trial.icpId);
		}

		expect(seeded.length).toBe(PROFILES.length * 2);
		for (const profile of PROFILES) {
			const trials = seeded.filter((trial) => trial.slug === profile.slug);
			expect(trials).toHaveLength(2);
			const first = trials.find((trial) => trial.trialIndex === 0);
			const second = trials.find((trial) => trial.trialIndex === 1);
			expect(first?.icpId).not.toBe(profile.icpId);
			expect(second?.icpId).not.toBe(first?.icpId);
			expect(new Set(trials.map((trial) => trial.organizationId)).size).toBe(2);
			for (const trial of trials) {
				expect(trial.apiKey.length).toBeGreaterThan(0);
			}
		}

		const sql = postgres(testEnv.HYPERDRIVE_DIRECT.connectionString, {
			max: 1,
		});
		try {
			const icpRows = await sql`select id from icp where id = any(${icpIds})`;
			expect(icpRows.length).toBe(seeded.length);
			const organizationRows =
				await sql`select id from organization where id = any(${organizationIds})`;
			expect(organizationRows.length).toBe(seeded.length);
			const apikeyRows =
				await sql`select reference_id from apikey where reference_id = any(${organizationIds})`;
			expect(apikeyRows.length).toBe(seeded.length);
		} finally {
			await sql.end();
		}
	});
});
