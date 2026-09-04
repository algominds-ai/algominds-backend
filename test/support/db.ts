import { env as testEnv } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { createAuth } from "@/auth";
import { ORGANIZATION_KEY_CONFIG_ID } from "@/auth-options";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { createIcp } from "@/core/db/icp";
import { organizationForSlug } from "@/core/db/organizations";
import type {
	DbFactory,
	EvidenceAppendConnection,
	EvidenceReadConnection,
	Organization,
	RunLookupConnection,
} from "@/core/db/queries";
import { saveCompanies, upsertPeople } from "@/core/db/queries";
import { saveRunCompanies } from "@/core/db/run-companies";
import { openRun } from "@/core/db/runs";
import type {
	Company,
	Evidence,
	Icp,
	NewEvidence,
	Person,
	Run,
} from "@/core/db/schema";
import {
	company,
	evidence,
	icp,
	person,
	run,
	runCompany,
} from "@/core/db/schema";
import type {
	RunCompanyExistsConnection,
	RunPeopleConnection,
} from "@/core/enrich";
import type { PersonData } from "@/core/people/rows";

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

/** A real ICP row for `org`, under a domain unique to this call. */
export async function seedIcpFor(
	org: Organization,
	label: string,
): Promise<Icp> {
	return createIcp(testEnv, {
		description: `seed icp for ${label}`,
		domain: `${label}-${crypto.randomUUID()}.internal`,
		organizationId: org.id,
	});
}

/** A real run row for `org`, under an id unique to this call. */
export async function seedRunFor(
	org: Organization,
	capability: string,
	overrides: Partial<Pick<Run, "icpId" | "status">> = {},
): Promise<Run> {
	return openRun(testEnv, {
		id: `${capability}_${crypto.randomUUID()}`,
		organizationId: org.id,
		icpId: overrides.icpId ?? null,
		capability,
		status: overrides.status ?? "complete",
	});
}

export type SeedCompanyOptions = { icpId?: string | null; foundAt?: Date };

/** A real company row for `org` under `run`, at a domain unique to this call. */
export async function seedCompanyFor(
	org: Organization,
	target: Run,
	label: string,
	options: SeedCompanyOptions = {},
): Promise<Company> {
	const [saved] = await saveCompanies(testEnv, [
		{
			icpId: options.icpId ?? null,
			organizationId: org.id,
			runId: target.id,
			domain: `${label}-${crypto.randomUUID()}.com`,
			name: label,
			foundAt: options.foundAt,
		},
	]);
	if (!saved) throw new Error(`seed failed to save a company for ${label}`);
	return saved;
}

/** Links a people run to a resolved company on its requested-domain row. */
export async function linkRunCompany(
	forRun: Run,
	toCompany: Company,
	mode: string,
	buyerSource: string,
): Promise<void> {
	await saveRunCompanies(testEnv, [
		{
			runId: forRun.id,
			domain: toCompany.domain,
			companyId: toCompany.id,
			identity: "domain",
			mode,
			buyerSource,
		},
	]);
}

/** A real person row for `org` at `target`, under a linkedin url unique to this call. */
export async function seedPersonFor(
	org: Organization,
	target: Company,
	name: string,
	data?: PersonData,
): Promise<Person> {
	const [saved] = await upsertPeople(testEnv, [
		{
			organizationId: org.id,
			companyId: target.id,
			linkedinUrl: `https://linkedin.com/in/${crypto.randomUUID()}`,
			name,
			data,
		},
	]);
	if (!saved) throw new Error(`seed failed to save a person for ${name}`);
	return saved;
}

/** Deletes every run, icp, company, person and evidence row these organizations own, then the organizations themselves. */
export async function wipeOrganizations(
	orgIds: readonly string[],
): Promise<void> {
	if (orgIds.length === 0) return;
	const ids = [...orgIds];
	await withConnection(testEnv, "direct", db, async (connection) => {
		const runs = await connection
			.select({ id: run.id })
			.from(run)
			.where(inArray(run.organizationId, ids));
		const runIds = runs.map((row) => row.id);
		const people = await connection
			.select({ id: person.id })
			.from(person)
			.where(inArray(person.organizationId, ids));
		const personIds = people.map((row) => row.id);
		const runCompanies = runIds.length
			? await connection
					.select({ id: runCompany.id })
					.from(runCompany)
					.where(inArray(runCompany.runId, runIds))
			: [];
		const subjectIds = [...personIds, ...runCompanies.map((row) => row.id)];
		if (subjectIds.length) {
			await connection
				.delete(evidence)
				.where(inArray(evidence.subjectId, subjectIds));
		}
		if (personIds.length) {
			await connection.delete(person).where(inArray(person.id, personIds));
		}
		if (runIds.length) {
			await connection
				.delete(runCompany)
				.where(inArray(runCompany.runId, runIds));
		}
		await connection
			.delete(company)
			.where(inArray(company.organizationId, ids));
		if (runIds.length) {
			await connection.delete(run).where(inArray(run.id, runIds));
		}
		await connection.delete(icp).where(inArray(icp.organizationId, ids));
	});
	await deleteOrganizations(ids);
}

export type IssuedKey = {
	key: string;
	id: string;
	organizationId: string;
	userId: string;
};

/** Mints a real api key for a real organization: signs up a user, creates an organization it owns, then mints a key for it. */
export async function issueOrganizationKey(label: string): Promise<IssuedKey> {
	const auth = createAuth(testEnv);
	const signedUp = await auth.api.signUpEmail({
		body: {
			name: label,
			email: `${label}-${crypto.randomUUID()}@algo.test`,
			password: "correct-horse-battery-staple",
		},
	});
	const org = await auth.api.createOrganization({
		body: { name: label, slug: label, userId: signedUp.user.id },
	});
	const created = await auth.api.createApiKey({
		body: {
			configId: ORGANIZATION_KEY_CONFIG_ID,
			organizationId: org.id,
			userId: signedUp.user.id,
			name: "test-key",
		},
	});
	return {
		key: created.key,
		id: created.id,
		organizationId: org.id,
		userId: signedUp.user.id,
	};
}

export async function disableOrganizationKey(issued: IssuedKey): Promise<void> {
	await createAuth(testEnv).api.updateApiKey({
		body: {
			configId: ORGANIZATION_KEY_CONFIG_ID,
			keyId: issued.id,
			userId: issued.userId,
			enabled: false,
		},
	});
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
