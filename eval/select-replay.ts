import { spawn } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { it } from "vitest";
import { z } from "zod";
import { company, evidence, icp, runCompany } from "@/core/db/schema";
import type { ResolvedBuyer } from "@/core/people/buyer";
import type { Candidate } from "@/core/people/candidate";
import type { DedupeRow } from "@/core/people/dedupe";
import type { SelectBuyersInput, SelectedBuyer } from "@/core/people/select";
import type { IcpDoc } from "@/core/synthesize";

const LOCAL_HOST = "postgresql://postgres:postgres@localhost:5432";
const DATABASE = "eval_p2screen-ondato";
const DOMAIN = "midnite.com";

type ExpectedLabel = "retain" | "reject";
type ExpectedPerson = { name: string; label: ExpectedLabel };

const EXPECTED: readonly ExpectedPerson[] = [
	{ name: "Andrew Mook", label: "reject" },
	{ name: "Ryan Attfield", label: "reject" },
	{ name: "Ryan Murton", label: "reject" },
	{ name: "Jonathan Shaw", label: "retain" },
	{ name: "Sam Talbot", label: "retain" },
	{ name: "Dave P.", label: "retain" },
	{ name: "Mike Laryea", label: "retain" },
];

const CompanyDataSchema = z
	.object({
		entity: z.object({ workforceTotal: z.number().nullish() }).nullish(),
	})
	.nullish();

type RawReplay = {
	companyName: string;
	companyWorkforceTotal: number | null;
	buyerMode: string | null;
	buyerSource: string | null;
	icpDoc: unknown;
	rosterPages: string[];
};

/**
 * The raw, unparsed rows `runBuyerMode` built its selector input from, for
 * `DOMAIN`'s company in `DATABASE`: the company's own headcount, the
 * profile's captured `icp.doc`, and every `roster`/`clay` evidence page
 * that carries a Clay run reply. Runs on plain Postgres, so this is the
 * only part of the replay that does not need the Workers runtime — every
 * production import that does (`dedupe`, the profile schemas, `selectBuyers`)
 * stays a dynamic `import()` inside `runInWorkersPool`, never a static one,
 * since a static one would make plain `bun run` try, and fail, to resolve
 * `cloudflare:workflows` before `main` ever chooses a code path.
 */
async function loadRawReplay(): Promise<RawReplay> {
	const client = postgres(`${LOCAL_HOST}/${DATABASE}`, { max: 1 });
	try {
		const db = drizzle(client);
		const [companyRow] = await db
			.select()
			.from(company)
			.where(eq(company.domain, DOMAIN));
		if (!companyRow) {
			throw new Error(`${DATABASE}: no company row for ${DOMAIN}`);
		}
		const [runCompanyRow] = await db
			.select()
			.from(runCompany)
			.where(eq(runCompany.domain, DOMAIN));
		if (!runCompanyRow) {
			throw new Error(`${DATABASE}: no run_company row for ${DOMAIN}`);
		}
		const [icpRow] = companyRow.icpId
			? await db.select().from(icp).where(eq(icp.id, companyRow.icpId))
			: [];
		const rosterRows = await db
			.select()
			.from(evidence)
			.where(
				and(
					eq(evidence.subjectId, runCompanyRow.id),
					eq(evidence.subjectType, "run_company"),
					eq(evidence.kind, "roster"),
					eq(evidence.source, "clay"),
				),
			)
			.orderBy(evidence.id);
		const data = CompanyDataSchema.parse(companyRow.data);
		return {
			companyName: companyRow.name,
			companyWorkforceTotal: data?.entity?.workforceTotal ?? null,
			buyerMode: runCompanyRow.mode,
			buyerSource: runCompanyRow.buyerSource,
			icpDoc: icpRow?.doc ?? null,
			rosterPages: rosterRows.map((row) => row.value),
		};
	} finally {
		await client.end();
	}
}

const ClayLocationSchema = z
	.object({ city: z.string().nullish(), country: z.string().nullish() })
	.nullish();

const ClayPageRowSchema = z
	.object({
		name: z.string().nullish(),
		url: z.string().nullish(),
		latest_experience_title: z.string().nullish(),
		latest_experience_company: z.string().nullish(),
		latest_experience_start_date: z.string().nullish(),
		location: z.string().nullish(),
		structured_location: ClayLocationSchema,
	})
	.passthrough();

const ClayPageSchema = z
	.object({ data: z.array(ClayPageRowSchema) })
	.passthrough();

/** Mirrors the private helper of the same name in `src/core/providers/clay.ts`: city and country joined, or null when neither is on record. */
function structuredLocation(
	value: z.infer<typeof ClayLocationSchema>,
): string | null {
	const parts = [value?.city, value?.country].filter((part): part is string =>
		Boolean(part),
	);
	return parts.length > 0 ? parts.join(", ") : null;
}

type CanonicalPersonUrl = (raw: string | null | undefined) => string | null;

function toDedupeRow(
	row: z.infer<typeof ClayPageRowSchema>,
	source: string,
	canonicalPersonUrl: CanonicalPersonUrl,
): DedupeRow {
	return {
		name: row.name ?? null,
		title: row.latest_experience_title ?? null,
		company: row.latest_experience_company ?? null,
		url: canonicalPersonUrl(row.url),
		location: row.location ?? structuredLocation(row.structured_location),
		since: row.latest_experience_start_date ?? null,
		source,
	};
}

/**
 * Every raw roster page that is a Clay run reply (a `data` array), turned
 * into `DedupeRow`s tagged `clay:page-N`. A create-search reply carries no
 * `data` array and is skipped. Evidence keeps no per-row band label, so `N`
 * is `raw.rosterPages`'s own order, not the seniority band Clay searched
 * under.
 */
function candidateRows(
	raw: RawReplay,
	canonicalPersonUrl: CanonicalPersonUrl,
): DedupeRow[] {
	const rows: DedupeRow[] = [];
	let pageNumber = 0;
	for (const value of raw.rosterPages) {
		const parsed = ClayPageSchema.safeParse(JSON.parse(value));
		if (!parsed.success) continue;
		pageNumber += 1;
		for (const clayRow of parsed.data.data) {
			rows.push(
				toDedupeRow(clayRow, `clay:page-${pageNumber}`, canonicalPersonUrl),
			);
		}
	}
	return rows;
}

type ReplayInput = { input: SelectBuyersInput; candidates: Candidate[] };

type ReplayDeps = {
	dedupe: (rows: DedupeRow[]) => Candidate[];
	canonicalPersonUrl: CanonicalPersonUrl;
	parseIcpDoc: (value: unknown) => IcpDoc;
	parseResolvedBuyer: (value: unknown) => ResolvedBuyer;
};

/** The exact `SelectBuyersInput` `runBuyerMode` built from `raw`: the roster rebuilt through the real `dedupe`, the buyer built through `ResolvedBuyerSchema`, and the company's own name and headcount. */
function buildReplayInput(raw: RawReplay, deps: ReplayDeps): ReplayInput {
	const icpDoc = deps.parseIcpDoc(raw.icpDoc);
	const buyer = deps.parseResolvedBuyer({
		mode: raw.buyerMode,
		buyerSource: raw.buyerSource,
		rubric: icpDoc.buyer?.rubric ?? null,
		bands: icpDoc.buyer?.bands ?? [],
		keywordBands: icpDoc.buyer?.keywordBands ?? [],
	});
	const candidates = deps.dedupe(candidateRows(raw, deps.canonicalPersonUrl));
	return {
		candidates,
		input: {
			description: icpDoc.description,
			buyer,
			candidates,
			company: {
				name: raw.companyName,
				workforceTotal: raw.companyWorkforceTotal,
			},
		},
	};
}

function rosterLine(candidate: Candidate): string {
	return `${candidate.id} | ${candidate.title ?? "(no title)"} | ${candidate.location ?? "(no location)"}`;
}

type ExpectedRow = {
	expected: ExpectedPerson;
	candidate: Candidate | undefined;
	picked: boolean | null;
};

function expectedRows(
	candidates: readonly Candidate[],
	pickedIds: ReadonlySet<number> | null,
): ExpectedRow[] {
	return EXPECTED.map((expected) => {
		const candidate = candidates.find((entry) => entry.name === expected.name);
		const picked = candidate && pickedIds ? pickedIds.has(candidate.id) : null;
		return { expected, candidate, picked };
	});
}

/** One expected person's line: unresolved when the name is not in the roster, resolved-only during a dry run (`picked` is null), otherwise the pick decision against `expected.label`. Returns the pass outcome, or null when there was nothing yet to compare. */
function printExpectedRow(row: ExpectedRow): boolean | null {
	const { expected, candidate, picked } = row;
	if (!candidate) {
		console.log(`  ${expected.name.padEnd(16)} NOT FOUND IN ROSTER  FAIL`);
		return false;
	}
	if (picked === null) {
		console.log(
			`  expected ${expected.label.padEnd(6)} id=${candidate.id}  ${expected.name}  (${candidate.title ?? "no title"})`,
		);
		return null;
	}
	const actual: ExpectedLabel = picked ? "retain" : "reject";
	const pass = actual === expected.label;
	console.log(
		`  ${expected.name.padEnd(16)} id=${candidate.id}  expected=${expected.label}  actual=${actual}  ${pass ? "PASS" : "FAIL"}`,
	);
	return pass;
}

function printDryRun(replay: ReplayInput): void {
	const { input, candidates } = replay;
	console.log(
		`company: ${input.company.name}, ${input.company.workforceTotal} employees`,
	);
	console.log(
		`buyer mode=${input.buyer.mode} source=${input.buyer.buyerSource}`,
	);
	console.log(`rubric: ${input.buyer.rubric}`);
	console.log(`description: ${input.description?.slice(0, 160)}...`);
	console.log(`\nroster: ${candidates.length} candidate(s)`);
	for (const candidate of candidates) console.log(`  ${rosterLine(candidate)}`);
	console.log("\nexpected labels resolved against this roster:");
	for (const row of expectedRows(candidates, null)) printExpectedRow(row);
}

function pickedCandidateIds(picks: readonly SelectedBuyer[]): Set<number> {
	return new Set(picks.map((pick) => pick.candidate.id));
}

type SelectBuyers = (
	input: SelectBuyersInput,
	env: Env,
) => Promise<{ picks: SelectedBuyer[]; costDollars: number }>;

async function printLiveOutcome(
	replay: ReplayInput,
	env: Env,
	selectBuyers: SelectBuyers,
): Promise<void> {
	console.log(
		`replaying selectBuyers over ${replay.candidates.length} candidate(s)`,
	);
	const result = await selectBuyers(replay.input, env);
	console.log(`\n${result.picks.length} candidate(s) picked:`);
	for (const pick of result.picks) {
		console.log(
			`  id=${pick.candidate.id}  ${pick.basis}  ${pick.candidate.title}`,
		);
	}
	console.log("\nexpected outcome:");
	const rows = expectedRows(
		replay.candidates,
		pickedCandidateIds(result.picks),
	);
	const pass = rows.map(printExpectedRow).filter((outcome) => outcome).length;
	console.log(`\n${pass} of ${EXPECTED.length} expected labels matched`);
	console.log(`$${result.costDollars.toFixed(4)} for this call`);
}

const RunnerInputSchema = z.object({
	SELECT_REPLAY_RAW: z.string().min(1),
	SELECT_REPLAY_MODE: z.enum(["dry", "live"]),
	SELECT_REPLAY_AIG_TOKEN: z.string(),
	SELECT_REPLAY_GATEWAY_BASE_URL: z.string(),
	SELECT_REPLAY_MODEL_ROUTE: z.string(),
});

/**
 * Runs inside the Workers pool, where `dedupe`, the profile schemas and
 * `selectBuyers` can all resolve `cloudflare:workflows`, imported here by a
 * dynamic `import()` for exactly that reason. Builds the replay input from
 * the raw rows `main` fetched over plain Postgres, then either prints it
 * (`dry`) or calls the real selector against `testEnv` with its vendor
 * secret and gateway routing replaced by the values
 * `vitest.select-replay.config.ts` read from `process.env` (`live`).
 */
async function runInWorkersPool(): Promise<void> {
	const { env: testEnv } = await import("cloudflare:workers");
	const { dedupe } = await import("@/core/people/dedupe");
	const { canonicalPersonUrl } = await import("@/core/providers/clay");
	const { ResolvedBuyerSchema } = await import("@/core/people/buyer");
	const { IcpDocSchema } = await import("@/core/synthesize");
	const { selectBuyers } = await import("@/core/people/select");
	const parsed = RunnerInputSchema.parse(testEnv);
	const raw: RawReplay = JSON.parse(parsed.SELECT_REPLAY_RAW);
	const replay = buildReplayInput(raw, {
		dedupe,
		canonicalPersonUrl,
		parseIcpDoc: (value) => IcpDocSchema.parse(value),
		parseResolvedBuyer: (value) => ResolvedBuyerSchema.parse(value),
	});
	if (parsed.SELECT_REPLAY_MODE === "dry") {
		printDryRun(replay);
		return;
	}
	await printLiveOutcome(
		replay,
		{
			...testEnv,
			CF_AIG_TOKEN: { get: async () => parsed.SELECT_REPLAY_AIG_TOKEN },
			AI_GATEWAY_BASE_URL: parsed.SELECT_REPLAY_GATEWAY_BASE_URL,
			MODEL_ROUTE_REASONING: parsed.SELECT_REPLAY_MODEL_ROUTE,
		},
		selectBuyers,
	);
}

async function main(argv: readonly string[]): Promise<void> {
	const raw = await loadRawReplay();
	const mode = argv.includes("--live") ? "live" : "dry";
	const child = spawn(
		"bunx",
		["vitest", "run", "--config", "vitest.select-replay.config.ts"],
		{
			stdio: "inherit",
			env: {
				...process.env,
				SELECT_REPLAY_RAW: JSON.stringify(raw),
				SELECT_REPLAY_MODE: mode,
			},
		},
	);
	await new Promise<void>((resolve, reject) => {
		child.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`eval:select:replay exited ${code}`)),
		);
	});
}

if (import.meta.main) {
	await main(process.argv.slice(2));
} else {
	it(
		"replays the buyer selector over the saved midnite.com roster",
		{ timeout: 120_000 },
		runInWorkersPool,
	);
}
