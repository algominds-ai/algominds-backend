import { env as testEnv } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import type {
	DbFactory,
	EvidenceAppendConnection,
	EvidenceReadConnection,
	Organization,
	RunLookupConnection,
} from "@/core/db/queries";
import type {
	Company,
	Evidence,
	NewEvidence,
	Person,
	Run,
} from "@/core/db/schema";
import type {
	RunCompanyExistsConnection,
	RunPeopleConnection,
} from "@/core/enrich";

/** A real organization row seeded under a slug unique to this call, for a test to own and clean up. */
export async function seedOrganization(label: string): Promise<Organization> {
	return organizationForSlug(
		testEnv,
		`${label}-${crypto.randomUUID()}.internal`,
		label,
	);
}

export async function deleteOrganizations(
	ids: readonly string[],
): Promise<void> {
	await withConnection(testEnv, "direct", db, (connection) =>
		connection.delete(organization).where(inArray(organization.id, [...ids])),
	);
}

export function fakeFindRun(
	row: Run | undefined,
): DbFactory<RunLookupConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(row ? [row] : []),
				}),
			}),
		}),
	});
}

export type Recorded = { condition?: unknown; mode?: "cached" | "direct" };

export function fakeCompanyExists(
	rows: { id: string }[],
	recorded: Recorded = {},
): DbFactory<RunCompanyExistsConnection> {
	return (_env, mode) => {
		recorded.mode = mode;
		return {
			select: () => ({
				from: () => ({
					where: (condition: unknown) => {
						recorded.condition = condition;
						return Promise.resolve(rows);
					},
				}),
			}),
		};
	};
}

export function fakeRunPeople(
	rows: { person: Person; company: Company }[],
	recorded: Recorded = {},
): DbFactory<RunPeopleConnection> {
	return (_env, mode) => {
		recorded.mode = mode;
		return {
			select: () => ({
				from: () => ({
					innerJoin: () => ({
						where: (condition: unknown) => {
							recorded.condition = condition;
							return Promise.resolve(rows);
						},
					}),
				}),
			}),
		};
	};
}

export function fakeReadEvidence(
	row: Evidence | undefined,
): DbFactory<EvidenceReadConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: () => Promise.resolve(row ? [row] : []),
					}),
				}),
			}),
		}),
	});
}

export function fakeReadEvidenceSequence(
	rows: (Evidence | undefined)[],
): DbFactory<EvidenceReadConnection> {
	let call = 0;
	return () => {
		const row = rows[call];
		call += 1;
		return {
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => ({
							limit: () => Promise.resolve(row ? [row] : []),
						}),
					}),
				}),
			}),
		};
	};
}

export function fakeWriteEvidence(
	sink: NewEvidence[],
): DbFactory<EvidenceAppendConnection> {
	return () => ({
		insert: () => ({
			values: (rows: NewEvidence | NewEvidence[]) => {
				sink.push(...(Array.isArray(rows) ? rows : [rows]));
				return { returning: () => Promise.resolve([]) };
			},
		}),
	});
}
