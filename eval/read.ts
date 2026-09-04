import type { RunReport, StoredCompanyRecord } from "@eval/headline";
import { IcpDocSchema } from "@eval/icp-doc";
import type { Sql } from "postgres";
import { z } from "zod";
import { hardPageRequirements } from "@/core/requirements";

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
		select domain, name, data from company where run_id = ${runId}`;
	return rows.map((row) => {
		const parsed = CompanyRowSchema.parse(row);
		return {
			domain: parsed.domain,
			name: parsed.name,
			citedPage: parsed.data?.result?.url ?? null,
			quote: parsed.data?.result?.quote ?? null,
			evidenceCheck: parsed.data?.result?.evidenceCheck ?? null,
		};
	});
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
	return hardPageRequirements(parsed.doc?.requirements ?? []).length > 0;
}

export type RoundDiagnostic = {
	ordinal: number;
	source: string | null;
	found: number;
	rejectCount: number;
	startedAt: string;
};

const RoundRowSchema = z.object({
	ordinal: z.number(),
	plan: z.object({ source: z.string().nullish() }).nullish(),
	found: z.number(),
	rejects: z.array(z.unknown()).nullish(),
	started_at: z.coerce.date(),
});

export async function readRoundDiagnostics(
	sql: Sql,
	runId: string,
): Promise<RoundDiagnostic[]> {
	const rows = await sql`
		select ordinal, plan, found, rejects, started_at
		from round where run_id = ${runId} order by ordinal`;
	return rows.map((row) => {
		const parsed = RoundRowSchema.parse(row);
		return {
			ordinal: parsed.ordinal,
			source: parsed.plan?.source ?? null,
			found: parsed.found,
			rejectCount: parsed.rejects?.length ?? 0,
			startedAt: parsed.started_at.toISOString(),
		};
	});
}
