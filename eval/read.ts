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
};

/** One round's plan, funnel and elapsed seconds, read from `round` alone. Seconds are bounded by the next round's start, or `finishedAt` for the last round; dollars are not stored per round (only cumulatively on `run`), so they are not reported here. */
export async function readRoundTraceRecords(
	sql: Sql,
	runId: string,
	finishedAt: string | null,
): Promise<RoundTraceRecord[]> {
	const rows = await sql`
		select ordinal, plan, found, rejected, started_at
		from round where run_id = ${runId} order by ordinal`;
	const parsed = rows.map((row) => RoundTraceRowSchema.parse(row));
	return parsed.map((row, index) => {
		const next = parsed[index + 1];
		const endsAt = next ? next.started_at.toISOString() : finishedAt;
		const seconds = endsAt
			? (new Date(endsAt).getTime() - row.started_at.getTime()) / 1000
			: null;
		const plans = row.plan ?? [];
		return {
			ordinal: row.ordinal,
			plans,
			route: plans[0]?.source ?? null,
			funnel: roundFunnel(row.found, row.rejected ?? null),
			startedAt: row.started_at.toISOString(),
			seconds,
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
