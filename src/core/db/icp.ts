import { eq } from "drizzle-orm";
import type { DbEnv } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type {
	DbFactory,
	IcpConnection,
	IcpDocUpdateConnection,
	IcpInsertConnection,
} from "@/core/db/queries";
import type { Icp, NewIcp } from "@/core/db/schema";
import { icp, run } from "@/core/db/schema";
import { type IcpDoc, IcpDocSchema } from "@/core/icp";

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
	doc: IcpDoc;
};

/** Inserts the profile and returns the stored row, on whichever connection the caller is already inside. */
async function insertIcp(
	connection: IcpInsertConnection,
	input: NewIcpInput,
): Promise<Icp> {
	const doc = IcpDocSchema.parse(input.doc);
	if (doc.seller.domain !== input.domain)
		throw new Error("insertIcp: profile domain differs from account domain");
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
	if (!input.doc.extracted)
		throw new Error("saveOnboardedIcp: extraction is incomplete");
	const connection = db(env, "cached");
	try {
		return await connection.transaction(async (tx) => {
			const [opened] = await tx
				.select()
				.from(run)
				.where(eq(run.id, input.runId))
				.for("update");
			if (
				!opened ||
				opened.organizationId !== input.organizationId ||
				opened.capability !== "onboarding"
			)
				throw new Error("saveOnboardedIcp: unknown onboarding run");
			if (opened.icpId) return opened.icpId;
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

/** Saves a newly extracted draft without altering the exact instructions that produced it. */
export async function saveIcpProfile(
	env: DbEnv,
	icpId: string,
	profile: IcpDoc,
	buildDb: DbFactory<IcpDocUpdateConnection> = db,
): Promise<IcpDoc> {
	const doc = IcpDocSchema.parse(profile);
	if (!doc.extracted)
		throw new Error("saveIcpProfile: extraction is incomplete");
	return withConnection(env, "direct", buildDb, async (connection) => {
		const rows = await connection
			.select()
			.from(icp)
			.where(eq(icp.id, icpId))
			.limit(1);
		const row = rows[0];
		if (!row) throw new Error(`saveIcpProfile: unknown icp ${icpId}`);
		const current = IcpDocSchema.parse(row.doc);
		if (
			current.instructions !== doc.instructions ||
			current.seller.domain !== doc.seller.domain
		) {
			throw new Error("saveIcpProfile: instructions changed during extraction");
		}
		if (current.extracted) return current;
		await connection.update(icp).set({ doc }).where(eq(icp.id, icpId));
		return doc;
	});
}
