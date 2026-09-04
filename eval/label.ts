import { createInterface } from "node:readline/promises";
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
	data: z
		.object({
			entity: z
				.object({
					industry: z.string().nullish(),
					description: z.string().nullish(),
				})
				.nullish(),
			result: z
				.object({
					fitReason: z.string().nullish(),
					url: z.string().nullish(),
				})
				.nullish(),
		})
		.nullish(),
});

type CompanyRow = z.infer<typeof CompanyRowSchema>;

async function fetchCompanyRows(
	sql: Sql,
	icpId: string,
): Promise<CompanyRow[]> {
	const rows = await sql`
		select domain, name, run_id, found_at, data
		from company where icp_id = ${icpId}
		order by found_at asc`;
	return rows.map((row) => CompanyRowSchema.parse(row));
}

function toStoredCompany(row: CompanyRow): StoredCompany {
	return {
		domain: row.domain,
		name: row.name,
		runId: row.run_id,
		foundAt: row.found_at.toISOString(),
	};
}

function toCompanyDetail(row: CompanyRow): CompanyDetail {
	return {
		domain: row.domain,
		name: row.name,
		industry: row.data?.entity?.industry ?? null,
		description: row.data?.entity?.description ?? null,
		fitReason: row.data?.result?.fitReason ?? null,
		citedPage: row.data?.result?.url ?? null,
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

async function labelProfile(slug: string, seedOnly: boolean): Promise<void> {
	const profile = profileBySlug(slug);
	if (!profile) throw new Error(`eval:label unknown profile ${slug}`);
	let key = readKeyFile(profile.slug, profile.icpId);
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("eval:label DATABASE_URL is not set");
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		const rows = await fetchCompanyRows(sql, profile.icpId);
		key = mergeStoredCompanies(key, rows.map(toStoredCompany));
		key = sortedKeyFile(key);
		writeKeyFile(key);
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
	if (!slug) {
		console.error("usage: bun run eval:label <profile> [--seed-only]");
		process.exit(1);
	}
	await labelProfile(slug, seedOnly);
}
