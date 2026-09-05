import { armDatabaseUrl } from "@eval/arm-db";
import { readPeopleKeyFile } from "@eval/keys-io";
import type {
	PeopleBars,
	PeopleVerdict,
	StoredPersonRecord,
	StoredRunCompany,
} from "@eval/people-headline";
import { computePeopleVerdict } from "@eval/people-headline";
import type { PeopleKeyFile } from "@eval/people-key";
import { profileBySlug } from "@eval/profiles";
import type { Sql } from "postgres";
import postgres from "postgres";
import { z } from "zod";

const PeopleRunRowSchema = z.object({
	id: z.string(),
	status: z.string(),
	cost_dollars: z.number(),
});

type PeopleRunRow = z.infer<typeof PeopleRunRowSchema>;

async function fetchPeopleRuns(
	sql: Sql,
	slug: string,
): Promise<PeopleRunRow[]> {
	const rows = await sql`
		select r.id, r.status, r.cost_dollars
		from run r
		join organization o on o.id = r.organization_id
		where o.name like ${`eval-${slug}-t%`} and r.capability = 'people'
		order by r.started_at asc`;
	return rows.map((row) => PeopleRunRowSchema.parse(row));
}

const RunCompanyRowSchema = z.object({
	domain: z.string(),
	people_verified: z.number(),
});

async function fetchRunCompanies(
	sql: Sql,
	runId: string,
): Promise<StoredRunCompany[]> {
	const rows = await sql`
		select domain, people_verified from run_company where run_id = ${runId}`;
	return rows.map((row) => {
		const parsed = RunCompanyRowSchema.parse(row);
		return { domain: parsed.domain, peopleVerified: parsed.people_verified };
	});
}

const PersonRowSchema = z.object({
	linkedin_url: z.string().nullable(),
	name: z.string().nullable(),
	title: z.string().nullable(),
	domain: z.string(),
	data: z.object({ location: z.string().nullable() }).nullish(),
});

async function fetchRunPeople(
	sql: Sql,
	runId: string,
): Promise<StoredPersonRecord[]> {
	const rows = await sql`
		select p.linkedin_url, p.name, p.title, p.data, rc.domain
		from person p
		join run_company rc on rc.company_id = p.company_id
		where rc.run_id = ${runId}`;
	return rows.map((row) => {
		const parsed = PersonRowSchema.parse(row);
		return {
			linkedinUrl: parsed.linkedin_url,
			name: parsed.name,
			title: parsed.title,
			company: parsed.domain,
			location: parsed.data?.location ?? null,
		};
	});
}

function failedGateNames(gates: PeopleVerdict["gates"]): string[] {
	return Object.entries(gates)
		.filter(([, passed]) => !passed)
		.map(([name]) => name);
}

function formatPersonLine(
	person: StoredPersonRecord,
	label: string | null,
): string {
	return `${person.company}: ${person.name ?? "?"} (${person.title ?? "?"}) ${label ?? "unlabelled"}`;
}

type VerdictLineInput = {
	slug: string;
	verdict: PeopleVerdict;
	people: readonly StoredPersonRecord[];
	key: PeopleKeyFile;
};

function formatVerdictLine(input: VerdictLineInput): string {
	const { slug, verdict, people, key } = input;
	const failed = failedGateNames(verdict.gates);
	const status = verdict.allGatesPass ? "PASS" : "FAIL";
	const failedText = failed.length > 0 ? ` ${failed.join(",")}` : "";
	const precisionText =
		verdict.precision === null ? "n/a" : verdict.precision.toFixed(2);
	const costText =
		verdict.costPerVerifiedPerson === null
			? "n/a"
			: verdict.costPerVerifiedPerson.toFixed(3);
	const peopleText = people
		.map((person) => {
			const label =
				person.linkedinUrl === null
					? null
					: (key.people[person.linkedinUrl]?.label ?? null);
			return formatPersonLine(person, label);
		})
		.join("; ");
	return (
		`${slug}: ${status}${failedText}, ${verdict.verifiedPerCompany.toFixed(2)} verified/company, ` +
		`precision ${precisionText}, $${costText}/verified, ` +
		`unlabelled ${verdict.unlabelledCount}, then ${peopleText}`
	);
}

async function scoreArm(arm: string, slug: string): Promise<void> {
	const profile = profileBySlug(slug);
	if (!profile) throw new Error(`eval:people unknown profile ${slug}`);
	const sql = postgres(armDatabaseUrl(arm), { max: 1 });
	try {
		const key = readPeopleKeyFile(profile.slug, profile.icpId);
		const bars: PeopleBars = {
			maxCostDollars: profile.bars.maxCostDollars,
			countries: profile.countries,
		};
		const runs = await fetchPeopleRuns(sql, slug);
		for (const run of runs) {
			const companies = await fetchRunCompanies(sql, run.id);
			const people = await fetchRunPeople(sql, run.id);
			const verdict = computePeopleVerdict({
				key,
				run: {
					runId: run.id,
					status: run.status,
					costDollars: run.cost_dollars,
				},
				companies,
				people,
				bars,
			});
			console.log(formatVerdictLine({ slug, verdict, people, key }));
		}
	} finally {
		await sql.end();
	}
}

if (import.meta.main) {
	const armIndex = process.argv.indexOf("--arm");
	const profileIndex = process.argv.indexOf("--profile");
	const arm = armIndex === -1 ? null : (process.argv[armIndex + 1] ?? null);
	const slug =
		profileIndex === -1 ? null : (process.argv[profileIndex + 1] ?? null);
	if (!arm || !slug) {
		console.error("usage: bun run eval:people --arm <arm> --profile <slug>");
		process.exit(1);
	}
	await scoreArm(arm, slug);
}
