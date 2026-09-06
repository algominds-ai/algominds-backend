import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import type { RequirementEvidence } from "@/core/companies/judge-evidence";
import { company, evidence, icp, run } from "@/core/db/schema";
import {
	evidenceDemandConditions,
	type Requirement,
	RequirementSchema,
} from "@/core/requirements";

const LOCAL_HOST = "postgresql://postgres:postgres@localhost:5432";

export type ExpectedVerdict = "retain" | "reject";

export type ReplayTarget = {
	domain: string;
	database: string;
	expected: ExpectedVerdict;
};

export const REPLAY_TARGETS: readonly ReplayTarget[] = [
	{ domain: "steadypay.co", database: "eval_p2final2", expected: "reject" },
	{ domain: "gettongo.com", database: "eval_p2final3", expected: "reject" },
	{ domain: "hioscar.com", database: "eval_p2final2", expected: "reject" },
	{ domain: "sennder.com", database: "eval_p2final2", expected: "reject" },
	{ domain: "algbra.com", database: "eval_p2final2", expected: "retain" },
	{ domain: "kontigo.lat", database: "eval_p2final3", expected: "retain" },
	{ domain: "paymiq.com", database: "eval_p2final3", expected: "retain" },
	{ domain: "ziglu.io", database: "eval_p2final3", expected: "retain" },
	{ domain: "peymo.com", database: "eval_p2final3", expected: "retain" },
	{ domain: "skyscanner.net", database: "eval_p2final2", expected: "retain" },
	{ domain: "dexcom.com", database: "eval_p2final2", expected: "retain" },
];

const CompanyEntitySchema = z.object({
	industry: z.string().nullable().optional(),
	workforceTotal: z.number().nullable().optional(),
	city: z.string().nullable().optional(),
	country: z.string().nullable().optional(),
	foundedYear: z.number().nullable().optional(),
	revenueAnnual: z.number().nullable().optional(),
	fundingTotal: z.number().nullable().optional(),
	description: z.string().nullable().optional(),
});

const CompanyResultSchema = z.object({
	url: z.string().nullable().optional(),
	quote: z.string().nullable().optional(),
	publisher: z.string().nullable().optional(),
	kind: z.string().nullable().optional(),
	publishedDate: z.string().nullable().optional(),
	signal: z.string().nullable().optional(),
});

const CompanyDataSchema = z.object({
	entity: CompanyEntitySchema.default({}),
	result: CompanyResultSchema.default({}),
});

const IcpDocSchema = z
	.object({ requirements: z.array(RequirementSchema).optional() })
	.nullable();

/** Mirrors `describeCompany` in `src/core/companies/candidates.ts`, the facts a search round writes onto a row's `description` before the judge ever sees it. */
function describeCompany(
	entity: z.infer<typeof CompanyEntitySchema>,
): string | null {
	const facts: string[] = [];
	if (entity.industry) facts.push(entity.industry);
	if (entity.workforceTotal != null)
		facts.push(`headcount ${entity.workforceTotal}`);
	if (entity.country)
		facts.push(`${entity.city ? `${entity.city}, ` : ""}${entity.country}`);
	if (entity.foundedYear != null) facts.push(`founded ${entity.foundedYear}`);
	if (entity.revenueAnnual != null)
		facts.push(`annual revenue ${entity.revenueAnnual} USD`);
	if (entity.fundingTotal != null)
		facts.push(`funding raised ${entity.fundingTotal} USD`);
	const description = (entity.description ?? "").slice(
		0,
		config.companies.descriptionChars,
	);
	const text = [facts.join("; "), description].filter(Boolean).join(". ");
	return text.length > 0 ? text : null;
}

export type ReplayCase = {
	domain: string;
	database: string;
	icpId: string | null;
	expected: ExpectedVerdict;
	requirements: Requirement[];
	row: CompanyRow;
	pageEvidence: Record<string, RequirementEvidence>;
};

type CompanyRecord = typeof company.$inferSelect;

function rowFromCompany(companyRow: CompanyRecord): CompanyRow {
	const parsedData = CompanyDataSchema.parse(companyRow.data);
	return {
		name: companyRow.name,
		domain: companyRow.domain,
		linkedinUrl: companyRow.linkedinUrl,
		evidenceUrl: parsedData.result.url ?? null,
		evidenceQuote: parsedData.result.quote ?? null,
		evidencePublisher: parsedData.result.publisher ?? null,
		evidenceKind: parsedData.result.kind ?? null,
		industry: companyRow.industry,
		description: describeCompany(parsedData.entity),
		signal: parsedData.result.signal ?? null,
		evidenceDate: parsedData.result.publishedDate ?? null,
	};
}

/** The row's own evidence keyed onto the sole hard page requirement it proved, matching how `recordRequirementEvidence` in `src/core/companies/proving.ts` stamps a round's first demand onto the row. Every profile touched here has at most one hard page requirement. */
export function pageEvidenceFor(
	requirements: readonly Requirement[],
	row: CompanyRow,
): Record<string, RequirementEvidence> {
	const primary = evidenceDemandConditions(requirements)[0];
	if (!primary || !row.evidenceUrl || !row.evidenceQuote) return {};
	return { [primary.id]: { url: row.evidenceUrl, quote: row.evidenceQuote } };
}

/** One fixture target's judge input, built from its saved `company` row and its `icp.doc.requirements`. */
export async function loadCase(target: ReplayTarget): Promise<ReplayCase> {
	const client = postgres(`${LOCAL_HOST}/${target.database}`, { max: 1 });
	try {
		const db = drizzle(client);
		const [companyRow] = await db
			.select()
			.from(company)
			.where(eq(company.domain, target.domain));
		if (!companyRow) {
			throw new Error(
				`${target.database}: no company row for ${target.domain}`,
			);
		}
		const [icpRow] = companyRow.icpId
			? await db.select().from(icp).where(eq(icp.id, companyRow.icpId))
			: [];
		const requirements =
			IcpDocSchema.parse(icpRow?.doc ?? null)?.requirements ?? [];
		const row = rowFromCompany(companyRow);
		return {
			domain: target.domain,
			database: target.database,
			icpId: companyRow.icpId,
			expected: target.expected,
			requirements,
			row,
			pageEvidence: pageEvidenceFor(requirements, row),
		};
	} finally {
		await client.end();
	}
}

export type RowsTarget = { database: string; slug: string };

export function parseRowsFlag(value: string): RowsTarget {
	const [database, slug] = value.split(":");
	if (!database || !slug) {
		throw new Error(`--rows needs <database>:<slug>, got "${value}"`);
	}
	return { database, slug };
}

/**
 * Every row a saved run kept for one profile. A round never persists a row
 * the judge refused as a `company` row — only its domain, reason and
 * statuses land in that round's own `round.rejects`, without the
 * description or evidence a replay needs — so every row this returns was,
 * by construction, one the original run's judge kept: `expected` is always
 * `"retain"`, and a `FAIL` here is today's judge refusing what that run
 * stored.
 */
export async function loadRunCases(target: RowsTarget): Promise<ReplayCase[]> {
	const client = postgres(`${LOCAL_HOST}/${target.database}`, { max: 1 });
	try {
		const db = drizzle(client);
		const icpRows = await db.select().from(icp);
		const icpRow = icpRows.find((row) => row.domain?.startsWith(target.slug));
		if (!icpRow) {
			throw new Error(
				`${target.database}: no icp domain starting with "${target.slug}"`,
			);
		}
		const requirements =
			IcpDocSchema.parse(icpRow.doc ?? null)?.requirements ?? [];
		const companyRows = await db
			.select()
			.from(company)
			.where(eq(company.icpId, icpRow.id));
		return companyRows.map((companyRow) => {
			const row = rowFromCompany(companyRow);
			return {
				domain: companyRow.domain,
				database: target.database,
				icpId: icpRow.id,
				expected: "retain" as const,
				requirements,
				row,
				pageEvidence: pageEvidenceFor(requirements, row),
			};
		});
	} finally {
		await client.end();
	}
}

const CapturedFieldsSchema = z.object({
	name: z.string().nullable(),
	domain: z.string().nullable(),
	description: z.string().nullable(),
	evidenceUrl: z.string().optional(),
	evidenceQuote: z.string().optional(),
});

const CapturedEvidenceSchema = z.record(
	z.string(),
	z.object({ url: z.string(), quote: z.string() }),
);

const CapturedJudgeInputSchema = z.object({
	domain: z.string(),
	fields: CapturedFieldsSchema,
	evidence: CapturedEvidenceSchema,
});

/** The row exactly as `judgedFields` cut it for the model: every other `CompanyRow` field never reaches the judge prompt, so it is left null rather than reconstructed. */
function rowFromCapturedFields(
	fields: z.infer<typeof CapturedFieldsSchema>,
): CompanyRow {
	return {
		name: fields.name,
		domain: fields.domain,
		linkedinUrl: null,
		evidenceUrl: fields.evidenceUrl ?? null,
		evidenceQuote: fields.evidenceQuote ?? null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: fields.description,
		signal: null,
		evidenceDate: null,
	};
}

type CapturedDb = ReturnType<typeof drizzle>;

async function icpIdForRun(
	db: CapturedDb,
	cache: Map<string, string | null>,
	runId: string,
): Promise<string | null> {
	if (!cache.has(runId)) {
		const [runRow] = await db.select().from(run).where(eq(run.id, runId));
		cache.set(runId, runRow?.icpId ?? null);
	}
	return cache.get(runId) ?? null;
}

async function requirementsForIcp(
	db: CapturedDb,
	cache: Map<string, Requirement[]>,
	icpId: string | null,
): Promise<Requirement[]> {
	if (icpId === null) return [];
	if (!cache.has(icpId)) {
		const [icpRow] = await db.select().from(icp).where(eq(icp.id, icpId));
		cache.set(
			icpId,
			IcpDocSchema.parse(icpRow?.doc ?? null)?.requirements ?? [],
		);
	}
	return cache.get(icpId) ?? [];
}

type CapturedRow = typeof evidence.$inferSelect;

async function caseFromCaptured(
	db: CapturedDb,
	database: string,
	caches: {
		icpIds: Map<string, string | null>;
		requirements: Map<string, Requirement[]>;
	},
	captured: CapturedRow,
): Promise<ReplayCase> {
	const parsed = CapturedJudgeInputSchema.parse(JSON.parse(captured.value));
	const icpId = await icpIdForRun(db, caches.icpIds, captured.subjectId);
	const requirements = await requirementsForIcp(db, caches.requirements, icpId);
	return {
		domain: parsed.domain,
		database,
		icpId,
		expected: "retain",
		requirements,
		row: rowFromCapturedFields(parsed.fields),
		pageEvidence: parsed.evidence,
	};
}

/**
 * Every row a saved run's own `judge-input` evidence recorded, verbatim: the
 * engine now writes one such row per candidate, just before the real judge
 * call, carrying the exact fields and evidence (homepage passage included)
 * that call saw. `expected` is always `"retain"` since ground truth is
 * unknown here — this mode screens the judge's timing and stability against
 * its own real inputs, not its accuracy.
 */
export async function loadCapturedCases(
	database: string,
): Promise<ReplayCase[]> {
	const client = postgres(`${LOCAL_HOST}/${database}`, { max: 1 });
	try {
		const db = drizzle(client);
		const rows = await db
			.select()
			.from(evidence)
			.where(eq(evidence.kind, "judge-input"));
		if (rows.length === 0) {
			throw new Error(`${database}: no judge-input evidence rows`);
		}
		const caches = {
			icpIds: new Map<string, string | null>(),
			requirements: new Map<string, Requirement[]>(),
		};
		const cases: ReplayCase[] = [];
		for (const captured of rows) {
			cases.push(await caseFromCaptured(db, database, caches, captured));
		}
		return cases;
	} finally {
		await client.end();
	}
}
