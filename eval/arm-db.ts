import { spawnSync } from "node:child_process";
import { ARM_SEED_PROFILES } from "@eval/arm-seed";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { authOptions, ORGANIZATION_KEY_CONFIG_ID } from "@/auth-options";
import * as authSchema from "@/core/db/auth-schema";
import * as schema from "@/core/db/schema";
import { icp } from "@/core/db/schema";

const LOCAL_HOST = "postgresql://postgres:postgres@localhost:5432";

export function armDatabaseName(arm: string): string {
	if (!/^[a-z][a-z0-9_]{0,45}$/.test(arm))
		throw new Error("eval: invalid database name");
	return `eval_${arm}`;
}

export function armDatabaseUrl(arm: string): string {
	return `${LOCAL_HOST}/${armDatabaseName(arm)}`;
}

function runOrThrow(
	cmd: string,
	args: readonly string[],
	env: Readonly<Record<string, string>> = {},
): void {
	const result = spawnSync(cmd, args, {
		encoding: "utf8",
		env: { ...process.env, PGPASSWORD: "postgres", ...env },
	});
	if (result.status !== 0) {
		throw new Error(
			`eval: ${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
		);
	}
}

/**
 * Creates `eval_<arm>`, refusing existing databases, then migrates it
 * — the same drop, create, migrate recipe `bun run db:test:reset` uses for
 * `algo_test`, parameterized by arm name so every arm gets its own database.
 */
export function bootstrapArmSchema(arm: string): void {
	const name = armDatabaseName(arm);
	runOrThrow("createdb", [
		"-h",
		"localhost",
		"-p",
		"5432",
		"-U",
		"postgres",
		name,
	]);
	runOrThrow("bunx", ["drizzle-kit", "migrate"], {
		DATABASE_URL: armDatabaseUrl(arm),
	});
}

export function dropArmDatabase(arm: string): void {
	runOrThrow("dropdb", [
		"--if-exists",
		"-h",
		"localhost",
		"-p",
		"5432",
		"-U",
		"postgres",
		armDatabaseName(arm),
	]);
}

export type SeededTrial = {
	slug: string;
	trialIndex: number;
	icpId: string;
	organizationId: string;
	apiKey: string;
};

type ArmAuth = ReturnType<typeof buildArmAuth>;

function buildArmAuth(connection: ReturnType<typeof drizzle>) {
	return betterAuth({
		...authOptions,
		database: drizzleAdapter(connection, {
			provider: "pg",
			schema: authSchema,
		}),
	});
}

/**
 * One organization, one API key and one `icp` row carrying the profile's
 * frozen document, all fresh for this one trial. Every trial gets its own
 * organization so the account's seen-domains window never excludes a
 * second trial's candidates as "already found" by the first.
 */
async function seedOneTrial(
	auth: ArmAuth,
	connection: ReturnType<typeof drizzle>,
	profile: (typeof ARM_SEED_PROFILES)[number],
	trialIndex: number,
): Promise<SeededTrial> {
	const label = `${profile.organizationName}-t${trialIndex}-${crypto.randomUUID().slice(0, 8)}`;
	const signedUp = await auth.api.signUpEmail({
		body: {
			name: label,
			email: `${label}@eval.internal`,
			password: crypto.randomUUID(),
		},
	});
	const org = await auth.api.createOrganization({
		body: { name: label, slug: label, userId: signedUp.user.id },
	});
	if (!org) throw new Error(`eval: organization not created for ${label}`);
	const created = await auth.api.createApiKey({
		body: {
			configId: ORGANIZATION_KEY_CONFIG_ID,
			organizationId: org.id,
			userId: signedUp.user.id,
			name: "eval",
		},
	});
	const icpId = crypto.randomUUID();
	await connection.insert(icp).values({
		id: icpId,
		organizationId: org.id,
		domain: profile.doc.seller?.domain ?? null,
		doc: profile.doc,
	});
	return {
		slug: profile.slug,
		trialIndex,
		icpId,
		organizationId: org.id,
		apiKey: created.key,
	};
}

/**
 * The actual seeding work, against whatever already-migrated database
 * `databaseUrl` names. Split from `seedArmProfiles` so a test can run it
 * against the Workers vitest pool's own test database, which is already
 * migrated, instead of needing `bootstrapArmSchema`'s `child_process` calls
 * that pool cannot make.
 */
export async function seedProfilesAt(
	databaseUrl: string,
	trials: number,
): Promise<SeededTrial[]> {
	const client = postgres(databaseUrl, { max: 1 });
	const connection = drizzle(client, { schema });
	const auth = buildArmAuth(connection);
	const seeded: SeededTrial[] = [];
	try {
		for (const profile of ARM_SEED_PROFILES) {
			for (let trialIndex = 0; trialIndex < trials; trialIndex++) {
				seeded.push(await seedOneTrial(auth, connection, profile, trialIndex));
			}
		}
	} finally {
		await client.end();
	}
	return seeded;
}

/**
 * One trial's worth of organization, API key and frozen `icp` row for every
 * profile the eval measures, inserted fresh into `eval_<arm>`. The returned
 * `apiKey` values exist only in memory for the caller to use immediately —
 * never logged, never written to a file.
 */
export function seedArmProfiles(
	arm: string,
	trials: number,
): Promise<SeededTrial[]> {
	return seedProfilesAt(armDatabaseUrl(arm), trials);
}

export async function seedCase(
	databaseUrl: string,
	profile: (typeof ARM_SEED_PROFILES)[number],
): Promise<SeededTrial> {
	const client = postgres(databaseUrl, { max: 1 });
	try {
		const connection = drizzle(client, { schema });
		return await seedOneTrial(buildArmAuth(connection), connection, profile, 0);
	} finally {
		await client.end();
	}
}
