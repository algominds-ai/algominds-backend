import type { RunReport, StoredCompanyRecord } from "@eval/headline";
import { IcpDocSchema } from "@eval/icp-doc";
import type { Sql } from "postgres";
import { z } from "zod";
import { evidenceDemandConditions } from "@/core/requirements";

const RunRowSchema = z.object({
	id: z.string(),
	cost_dollars: z.number(),
	started_at: z.coerce.date(),
	finished_at: z.coerce.date().nullable(),
});

export async function readRunReport(
	sql: Sql,
	runId: string,
): Promise<RunReport> {
	const rows = await sql`
		select id, cost_dollars, started_at, finished_at
		from run where id = ${runId}`;
	const row = RunRowSchema.parse(rows[0]);
	return {
		runId: row.id,
		costDollars: row.cost_dollars,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
	};
}

const CompanyRowSchema = z.object({
	domain: z.string(),
	name: z.string(),
	evidence_url: z.string().nullish(),
	proving_page_stored: z.boolean(),
	data: z
		.object({
			result: z
				.object({
					url: z.string().nullish(),
					quote: z.string().nullish(),
					evidenceCheck: z.string().nullish(),
				})
				.nullish(),
		})
		.nullish(),
});

export async function readStoredCompanies(
	sql: Sql,
	runId: string,
): Promise<StoredCompanyRecord[]> {
	const rows = await sql`
		select c.domain, c.name, c.data,
			(select e.value from evidence e
				where e.subject_id = c.id::text and e.kind = 'evidenceUrl' limit 1)
				as evidence_url,
			exists (select 1 from evidence e
				where e.subject_id = c.id::text and e.kind = 'proving-page')
				as proving_page_stored
		from company c where c.run_id = ${runId}`;
	return rows.map((row) => {
		const parsed = CompanyRowSchema.parse(row);
		return {
			domain: parsed.domain,
			name: parsed.name,
			citedPage: parsed.evidence_url ?? parsed.data?.result?.url ?? null,
			quote: parsed.data?.result?.quote ?? null,
			evidenceCheck: parsed.data?.result?.evidenceCheck ?? null,
			provingPageStored: parsed.proving_page_stored,
		};
	});
}

const RunStatusRowSchema = z.object({ status: z.string() });

/** The run's own status column, the terminal state `waitForRunTerminal` already waited for. */
export async function readRunStatus(sql: Sql, runId: string): Promise<string> {
	const rows = await sql`select status from run where id = ${runId}`;
	return RunStatusRowSchema.parse(rows[0]).status;
}

const IcpRowSchema = z.object({ doc: IcpDocSchema.nullish() });

/** Whether the profile's own requirements name a hard page requirement, the only case a stored company must carry a proven citation. */
export async function readRequiresProvingPass(
	sql: Sql,
	icpId: string,
): Promise<boolean> {
	const rows = await sql`select doc from icp where id = ${icpId}`;
	const row = rows[0];
	if (!row) return false;
	const parsed = IcpRowSchema.parse(row);
	return (
		evidenceDemandConditions(parsed.doc?.icp.requirements ?? []).length > 0
	);
}
