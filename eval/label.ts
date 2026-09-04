import { createInterface } from "node:readline/promises";
import { armDatabaseUrl } from "@eval/arm-db";
import { keyPath, readKeyFile, writeKeyFile } from "@eval/keys-io";
import type { CompanyDetail, KeyFile, StoredCompany } from "@eval/label-core";
import {
	formatCompanyDetail,
	isValidLabel,
	mergeStoredCompanies,
	sortedKeyFile,
	unlabelledDomains,
} from "@eval/label-core";
import { profileBySlug } from "@eval/profiles";
import type { Sql } from "postgres";
import postgres from "postgres";
import { z } from "zod";

const CompanyRowSchema = z.object({
	domain: z.string(),
	name: z.string(),
	run_id: z.string(),
	found_at: z.coerce.date(),
	evidence_url: z.string().nullish(),
	evidence_date: z.string().nullish(),
	data: z
		.object({
			entity: z
				.object({
					industry: z.string().nullish(),
					description: z.string().nullish(),
					workforceTotal: z.number().nullish(),
					country: z.string().nullish(),
					foundedYear: z.number().nullish(),
				})
				.nullish(),
			result: z
				.object({
					fitReason: z.string().nullish(),
					url: z.string().nullish(),
					quote: z.string().nullish(),
					publishedDate: z.string().nullish(),
				})
				.nullish(),
		})
		.nullish(),
});

type CompanyRow = z.infer<typeof CompanyRowSchema>;

type Scope = { icpId: string } | { armSlug: string };

/** Every company stored for the profile: by profile id in the shared database, or by the `eval-<slug>-t<n>` organizations an arm database seeded. */
async function fetchCompanyRows(sql: Sql, scope: Scope): Promise<CompanyRow[]> {
	const where =
		"icpId" in scope
			? sql`c.icp_id = ${scope.icpId}`
			: sql`o.name like ${`eval-${scope.armSlug}-t%`}`;
	const rows = await sql`
		select c.domain, c.name, c.run_id, c.found_at, c.data,
			(select e.value from evidence e
				where e.subject_id = c.id::text and e.kind = 'evidenceUrl' limit 1)
				as evidence_url,
			(select e.value from evidence e
				where e.subject_id = c.id::text and e.kind = 'evidenceDate' limit 1)
				as evidence_date
		from company c
		join run r on r.id = c.run_id
		join organization o on o.id = r.organization_id
		where ${where}
		order by c.found_at asc`;
	return rows.map((row) => CompanyRowSchema.parse(row));
}

function toStoredCompany(row: CompanyRow): StoredCompany {
	return {
		domain: row.domain,
		name: row.name,
		runId: row.run_id,
		foundAt: row.found_at.toISOString(),
		record: {
			industry: row.data?.entity?.industry ?? null,
			description: row.data?.entity?.description ?? null,
			workforceTotal: row.data?.entity?.workforceTotal ?? null,
			country: row.data?.entity?.country ?? null,
			foundedYear: row.data?.entity?.foundedYear ?? null,
			citedPage: row.evidence_url ?? row.data?.result?.url ?? null,
			citedDate: row.evidence_date ?? row.data?.result?.publishedDate ?? null,
			quote: row.data?.result?.quote ?? null,
			fitReason: row.data?.result?.fitReason ?? null,
		},
	};
}

function toCompanyDetail(row: CompanyRow): CompanyDetail {
	const stored = toStoredCompany(row);
	return {
		domain: row.domain,
		name: row.name,
		industry: stored.record.industry,
		description: stored.record.description,
		fitReason: stored.record.fitReason,
		citedPage: stored.record.citedPage,
	};
}

const LABEL_PROMPT =
	"label (accept / reject:<category> / same-as:<domain> / blank to skip, q to quit): ";

type PromptOutcome = { key: KeyFile; quit: boolean };

async function promptOneDomain(
	rl: ReturnType<typeof createInterface>,
	key: KeyFile,
	domain: string,
	detail: CompanyDetail,
): Promise<PromptOutcome> {
	console.log(`\n${formatCompanyDetail(detail)}`);
	const typed = (await rl.question(LABEL_PROMPT)).trim();
	if (typed === "q") return { key, quit: true };
	if (typed === "" || !isValidLabel(typed)) {
		if (typed !== "") console.log(`skipped: "${typed}" is not a valid label`);
		return { key, quit: false };
	}
	const entry = key.companies[domain];
	if (!entry) return { key, quit: false };
	const labelled: KeyFile = {
		...key,
		companies: { ...key.companies, [domain]: { ...entry, label: typed } },
	};
	writeKeyFile(sortedKeyFile(labelled));
	return { key: labelled, quit: false };
}

async function promptForLabels(
	key: KeyFile,
	detailByDomain: ReadonlyMap<string, CompanyDetail>,
): Promise<KeyFile> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let labelled = key;
	try {
		for (const domain of unlabelledDomains(key)) {
			const detail = detailByDomain.get(domain);
			if (!detail) continue;
			const outcome = await promptOneDomain(rl, labelled, domain, detail);
			labelled = outcome.key;
			if (outcome.quit) break;
		}
	} finally {
		rl.close();
	}
	return labelled;
}

/** `slug`'s key file, merged with every company row `scope` finds and written back sorted. */
async function seedKeyFile(
	sql: Sql,
	slug: string,
	scope: Scope,
): Promise<{ key: KeyFile; rows: CompanyRow[] }> {
	const profile = profileBySlug(slug);
	if (!profile) throw new Error(`eval:label unknown profile ${slug}`);
	const rows = await fetchCompanyRows(sql, scope);
	const key = sortedKeyFile(
		mergeStoredCompanies(
			readKeyFile(profile.slug, profile.icpId),
			rows.map(toStoredCompany),
		),
	);
	writeKeyFile(key);
	return { key, rows };
}

export type SeedResult = { companyCount: number; unlabelledCount: number };

/** Seeds `slug`'s key file from every company an arm database's `eval-<slug>-t<n>` organizations stored, exactly what `bun run eval:label <slug> --seed-only --arm <arm>` does. */
export async function seedKeyFileFromArm(
	sql: Sql,
	slug: string,
): Promise<SeedResult> {
	const { key } = await seedKeyFile(sql, slug, { armSlug: slug });
	return {
		companyCount: Object.keys(key.companies).length,
		unlabelledCount: unlabelledDomains(key).length,
	};
}

type LabelArgs = { slug: string; seedOnly: boolean; arm: string | null };

async function labelProfile(args: LabelArgs): Promise<void> {
	const { slug, seedOnly, arm } = args;
	const profile = profileBySlug(slug);
	if (!profile) throw new Error(`eval:label unknown profile ${slug}`);
	const databaseUrl = arm ? armDatabaseUrl(arm) : process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("eval:label DATABASE_URL is not set");
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		const scope: Scope = arm ? { armSlug: slug } : { icpId: profile.icpId };
		const { key, rows } = await seedKeyFile(sql, slug, scope);
		const pending = unlabelledDomains(key).length;
		console.log(
			`${slug}: ${Object.keys(key.companies).length} companies, ${pending} unlabelled, wrote ${keyPath(slug)}`,
		);
		if (seedOnly || !process.stdin.isTTY) return;
		const detailByDomain = new Map(
			rows.map((row) => [row.domain, toCompanyDetail(row)]),
		);
		const reviewed = await promptForLabels(key, detailByDomain);
		writeKeyFile(sortedKeyFile(reviewed));
	} finally {
		await sql.end();
	}
}

if (import.meta.main) {
	const slug = process.argv[2];
	const seedOnly = process.argv.includes("--seed-only");
	const armIndex = process.argv.indexOf("--arm");
	const arm = armIndex === -1 ? null : (process.argv[armIndex + 1] ?? null);
	if (!slug) {
		console.error(
			"usage: bun run eval:label <profile> [--seed-only] [--arm <arm>]",
		);
		process.exit(1);
	}
	await labelProfile({ slug, seedOnly, arm });
}
