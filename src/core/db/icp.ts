import { eq } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type {
	DbFactory,
	IcpConnection,
	IcpInsertConnection,
} from "@/core/db/queries";
import type { Icp, NewIcp } from "@/core/db/schema";
import { icp, run } from "@/core/db/schema";
import type { IcpDoc, IcpSeller } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";

export async function loadIcp(
	env: DbEnv,
	icpId: string,
	buildDb: DbFactory<IcpConnection> = db,
): Promise<Icp | undefined> {
	const connection = buildDb(env, "cached");
	const rows = await connection
		.select()
		.from(icp)
		.where(eq(icp.id, icpId))
		.limit(1);
	return rows[0];
}

export type NewIcpInput = Pick<NewIcp, "domain" | "organizationId"> & {
	description: string;
	seller?: IcpSeller | null;
};

/** Inserts the profile and returns the stored row, on whichever connection the caller is already inside. */
async function insertIcp(
	connection: IcpInsertConnection,
	input: NewIcpInput,
): Promise<Icp> {
	const doc: IcpDoc = IcpDocSchema.parse({
		description: input.description,
		seller: input.seller ?? null,
	});
	const rows = await connection
		.insert(icp)
		.values({
			domain: input.domain,
			organizationId: input.organizationId,
			doc,
		})
		.returning();
	const row = rows[0];
	if (!row) throw new Error("insertIcp: insert returned no row");
	return row;
}

export async function saveOnboardedIcp(
	env: DbEnv,
	input: NewIcpInput & { runId: string; costDollars: number },
): Promise<string> {
	return db(env, "cached").transaction(async (tx) => {
		const row = await insertIcp(tx, input);
		await tx
			.update(run)
			.set({
				status: "complete",
				costDollars: input.costDollars,
				icpId: row.id,
				finishedAt: new Date(),
			})
			.where(eq(run.id, input.runId));
		return row.id;
	});
}

/** Stores the whole ideal customer profile document, description and seller block alike. */
export async function createIcp(
	env: DbEnv,
	input: NewIcpInput,
	buildDb: DbFactory<IcpInsertConnection> = db,
): Promise<Icp> {
	return insertIcp(buildDb(env, "cached"), input);
}
