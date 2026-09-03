import { eq } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type {
	DbFactory,
	IcpConnection,
	IcpInsertConnection,
} from "@/core/db/queries";
import type { Icp, NewIcp } from "@/core/db/schema";
import { icp, run } from "@/core/db/schema";
import type { IcpBuyer, IcpDoc, IcpSeller } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";

export async function loadIcp(
	env: DbEnv,
	icpId: string,
	buildDb: DbFactory<IcpConnection> = db,
): Promise<Icp | undefined> {
	const rows = await withConnection(env, "cached", buildDb, (connection) =>
		connection.select().from(icp).where(eq(icp.id, icpId)).limit(1),
	);
	return rows[0];
}

export type NewIcpInput = Pick<NewIcp, "domain" | "organizationId"> & {
	description: string;
	seller?: IcpSeller | null;
	buyer?: IcpBuyer | null;
};

/** Inserts the profile and returns the stored row, on whichever connection the caller is already inside. */
async function insertIcp(
	connection: IcpInsertConnection,
	input: NewIcpInput,
): Promise<Icp> {
	const doc: IcpDoc = IcpDocSchema.parse({
		description: input.description,
		seller: input.seller ?? null,
		buyer: input.buyer ?? null,
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
	const connection = db(env, "cached");
	try {
		return await connection.transaction(async (tx) => {
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
	} finally {
		await connection.$client.end();
	}
}

/** Stores the whole ideal customer profile document, description and seller block alike. */
export async function createIcp(
	env: DbEnv,
	input: NewIcpInput,
	buildDb: DbFactory<IcpInsertConnection> = db,
): Promise<Icp> {
	return withConnection(env, "cached", buildDb, (connection) =>
		insertIcp(connection, input),
	);
}
