import type { RunReport, StoredCompanyRecord } from "@eval/headline";
import { IcpDocSchema } from "@eval/icp-doc";
import type { Sql } from "postgres";
import { z } from "zod";
import { hardPageRequirements, hardRequirements } from "@/core/requirements";

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

/** Every hard, record-proof requirement's own text, for `queryCarriesHardRequirements` to check a round's query against. */
export async function readHardRecordRequirementTexts(
	sql: Sql,
	icpId: string,
): Promise<string[]> {
	const rows = await sql`select doc from icp where id = ${icpId}`;
	const row = rows[0];
	if (!row) return [];
	const parsed = IcpRowSchema.parse(row);
	return hardRequirements(parsed.doc?.requirements ?? [])
		.filter((req) => req.proof === "record")
		.map((req) => req.text);
}

const SearchPlanTraceSchema = z
	.object({
		query: z.string(),
		angle: z.string(),
		pageQuery: z.string().nullish(),
		recency: z.string().nullish(),
		eventWindowDays: z.number().nullish(),
		recencyDays: z.number().nullish(),
		source: z.string().nullish(),
		agentEffort: z.string().nullish(),
		userLocation: z.string().nullish(),
		countries: z.array(z.string()).nullish(),
		minWorkforce: z.number().nullish(),
		maxWorkforce: z.number().nullish(),
		minFoundedYear: z.number().nullish(),
		maxFoundedYear: z.number().nullish(),
		minRevenueAnnual: z.number().nullish(),
		maxRevenueAnnual: z.number().nullish(),
		minFundingTotal: z.number().nullish(),
		maxFundingTotal: z.number().nullish(),
	})
	.passthrough();

export type SearchPlanTrace = z.infer<typeof SearchPlanTraceSchema>;

const RejectedCountsSchema = z.object({
	filter: z.number(),
	gate: z.number(),
	judge: z.number(),
});

/** `round.plan` as an array of every angle the round searched, normally already the shape `roundPlan` writes; a bare object is an older round's single-angle shape, wrapped here to the same array. */
function toPlanArray(
	value: SearchPlanTrace | SearchPlanTrace[],
): SearchPlanTrace[] {
	return Array.isArray(value) ? value : [value];
}

const RoundPlanSchema = z
	.union([z.array(SearchPlanTraceSchema), SearchPlanTraceSchema])
	.nullish()
	.transform((value) =>
		value === null || value === undefined ? value : toPlanArray(value),
	);

const RoundTraceRowSchema = z.object({
	ordinal: z.number(),
	plan: RoundPlanSchema,
	found: z.number(),
	rejected: RejectedCountsSchema.nullish(),
	started_at: z.coerce.date(),
});

/**
 * A round's funnel read from `round.found` and `round.rejected`'s three
 * uncapped stage counts. `gated` already reflects proof passing where a plan
 * demanded it, since `persistRound` folds an evidence-proof rejection into
 * the same `gate` bucket as a domain rejection — see
 * `docs/solutions/eval.md`.
 */
export type RoundFunnel = {
	returned: number;
	inBounds: number;
	gated: number;
	judgedKept: number;
	judgedRefused: number;
};

function roundFunnel(
	found: number,
	rejected: z.infer<typeof RejectedCountsSchema> | null,
): RoundFunnel {
	const filter = rejected?.filter ?? 0;
	const gate = rejected?.gate ?? 0;
	const judge = rejected?.judge ?? 0;
	return {
		returned: filter + gate + judge + found,
		inBounds: gate + judge + found,
		gated: judge + found,
		judgedKept: found,
		judgedRefused: judge,
	};
}

export type RoundTraceRecord = {
	ordinal: number;
	plans: SearchPlanTrace[];
	route: string | null;
	funnel: RoundFunnel;
	startedAt: string;
	seconds: number | null;
	secondsByDep: Record<string, number>;
};

const RoundTimingsValueSchema = z.object({
	round: z.number(),
	timings: z.array(z.object({ dep: z.string(), seconds: z.number() })),
});

/** Seconds per dependency for every round of `runId`, summed by dependency name from the `round-timings` evidence rows, keyed by round ordinal. */
export async function readRoundTimings(
	sql: Sql,
	runId: string,
): Promise<Map<number, Record<string, number>>> {
	const rows = await sql`
		select value from evidence
		where subject_type = 'run' and subject_id = ${runId} and kind = 'round-timings'`;
	const byRound = new Map<number, Record<string, number>>();
	for (const row of rows) {
		const parsed = RoundTimingsValueSchema.parse(JSON.parse(String(row.value)));
		const totals: Record<string, number> = {};
		for (const timing of parsed.timings) {
			totals[timing.dep] = (totals[timing.dep] ?? 0) + timing.seconds;
		}
		byRound.set(parsed.round, totals);
	}
	return byRound;
}

/** One round's plan, funnel, elapsed seconds and seconds per dependency. A round row is inserted when the round ends, so its seconds run from the previous round's insert, or the run's start, to its own; dollars are not stored per round (only cumulatively on `run`), so they are not reported here. */
export async function readRoundTraceRecords(
	sql: Sql,
	run: RunReport,
): Promise<RoundTraceRecord[]> {
	const rows = await sql`
		select ordinal, plan, found, rejected, started_at
		from round where run_id = ${run.runId} order by ordinal`;
	const parsed = rows.map((row) => RoundTraceRowSchema.parse(row));
	const timings = await readRoundTimings(sql, run.runId);
	return parsed.map((row, index) => {
		const previous = parsed[index - 1];
		const beganAt = previous
			? previous.started_at.toISOString()
			: run.startedAt;
		const seconds =
			(row.started_at.getTime() - new Date(beganAt).getTime()) / 1000;
		const plans = row.plan ?? [];
		return {
			ordinal: row.ordinal,
			plans,
			route: plans[0]?.source ?? null,
			funnel: roundFunnel(row.found, row.rejected ?? null),
			startedAt: row.started_at.toISOString(),
			seconds,
			secondsByDep: timings.get(row.ordinal) ?? {},
		};
	});
}

const RoundRefusalRowSchema = z.object({
	domain: z.string().nullable(),
	reason: z.string(),
	statuses: z.array(z.object({ id: z.string(), status: z.string() })).nullish(),
});

export type RoundRefusalRow = z.infer<typeof RoundRefusalRowSchema>;

const RoundRefusalsValueSchema = z.object({
	round: z.number(),
	refused: z.array(RoundRefusalRowSchema),
});

/** Every round's judge-refused rows, keyed by round ordinal, read from the run's `round-refusals` evidence — the judge's own statuses and reasons for each row it turned away. */
export async function readRoundRefusals(
	sql: Sql,
	runId: string,
): Promise<Map<number, RoundRefusalRow[]>> {
	const rows = await sql`
		select value from evidence
		where subject_type = 'run' and subject_id = ${runId} and kind = 'round-refusals'`;
	const byRound = new Map<number, RoundRefusalRow[]>();
	for (const row of rows) {
		const parsed = RoundRefusalsValueSchema.safeParse(
			JSON.parse(String(row.value)),
		);
		if (parsed.success) byRound.set(parsed.data.round, parsed.data.refused);
	}
	return byRound;
}

const CompanyTraceRowSchema = z.object({
	domain: z.string(),
	name: z.string(),
	industry: z.string().nullable(),
	data: z
		.object({
			entity: z
				.object({
					description: z.string().nullish(),
					workforceTotal: z.number().nullish(),
					country: z.string().nullish(),
				})
				.nullish(),
			result: z
				.object({
					url: z.string().nullish(),
					quote: z.string().nullish(),
					evidenceCheck: z.string().nullish(),
					fitReason: z.string().nullish(),
				})
				.nullish(),
		})
		.nullish(),
});

export type CompanyTraceRecord = {
	domain: string;
	name: string;
	industry: string | null;
	description: string | null;
	workforceTotal: number | null;
	country: string | null;
	citedPage: string | null;
	quote: string | null;
	evidenceCheck: string | null;
	fitReason: string | null;
};

/** Every stored company's record, description, headcount, cited page and judge fit reason, for one company span each. */
export async function readCompanyTraceRecords(
	sql: Sql,
	runId: string,
): Promise<CompanyTraceRecord[]> {
	const rows = await sql`
		select domain, name, industry, data from company
		where run_id = ${runId} order by found_at`;
	return rows.map((row) => {
		const parsed = CompanyTraceRowSchema.parse(row);
		return {
			domain: parsed.domain,
			name: parsed.name,
			industry: parsed.industry,
			description: parsed.data?.entity?.description ?? null,
			workforceTotal: parsed.data?.entity?.workforceTotal ?? null,
			country: parsed.data?.entity?.country ?? null,
			citedPage: parsed.data?.result?.url ?? null,
			quote: parsed.data?.result?.quote ?? null,
			evidenceCheck: parsed.data?.result?.evidenceCheck ?? null,
			fitReason: parsed.data?.result?.fitReason ?? null,
		};
	});
}
