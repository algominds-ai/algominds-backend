import type { Sql } from "postgres";
import { z } from "zod";
import { nameKey } from "@/core/people/dedupe";
import { canonicalPersonUrl } from "@/core/providers/clay";

const RunCompanyRowSchema = z.object({
	id: z.string(),
	domain: z.string(),
	companyId: z.string().nullable(),
	identity: z.string().nullable(),
	mode: z.string().nullable(),
	peopleRoster: z.number(),
});

const PersonRowSchema = z.object({
	id: z.string(),
	companyId: z.string(),
	linkedinUrl: z.string().nullable(),
	name: z.string().nullable(),
	title: z.string().nullable(),
});

const EvidenceRowSchema = z.object({
	subjectType: z.string(),
	subjectId: z.string(),
	kind: z.string(),
	value: z.string(),
});

type RawItem = { kind: string; body: unknown };

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

const PersonEvidenceEnvelopeSchema = z.object({
	runCompanyId: z.string(),
	body: z.unknown(),
});

function itemBody(items: readonly RawItem[], kind: string): unknown {
	return items.find((item) => item.kind === kind)?.body ?? null;
}

export type QuoteCheck = { found: boolean | null; reason: string | null };

export type PickTraceRecord = {
	name: string | null;
	title: string | null;
	verified: boolean;
	verdict: string | null;
	indexEmployer: string | null;
	agreement: string | null;
	quoteCheck: QuoteCheck | null;
};

const VerdictBodySchema = z.object({ verdict: z.string() });
const AgreementBodySchema = z.object({ employer: z.string() });
const QuoteCheckBodySchema = z.object({
	found: z.boolean().nullish(),
	reason: z.string().nullish(),
});

function verdictOf(items: readonly RawItem[]): string | null {
	if (items.some((item) => item.kind === "verify-error")) return "error";
	const parsed = VerdictBodySchema.safeParse(itemBody(items, "verify-poll"));
	return parsed.success ? parsed.data.verdict : null;
}

function agreementOf(items: readonly RawItem[]): string | null {
	const parsed = AgreementBodySchema.safeParse(itemBody(items, "verify-agree"));
	return parsed.success ? parsed.data.employer : null;
}

function quoteCheckOf(items: readonly RawItem[]): QuoteCheck | null {
	const parsed = QuoteCheckBodySchema.safeParse(
		itemBody(items, "verify-quote"),
	);
	if (!parsed.success) return null;
	return {
		found: parsed.data.found ?? null,
		reason: parsed.data.reason ?? null,
	};
}

const IndexReplySchema = z
	.object({
		results: z
			.array(
				z.object({
					url: z.string().nullish(),
					person: z
						.object({
							fullName: z.string().nullish(),
							workHistory: z
								.array(
									z.object({
										companyName: z.string().nullish(),
										current: z.boolean().nullish(),
									}),
								)
								.nullish(),
						})
						.nullish(),
				}),
			)
			.nullish(),
	})
	.passthrough();

/**
 * The current employer the index reply names for one candidate, matched the
 * same way `indexOpinion` (src/core/people/verify.ts) matches: first by
 * canonical LinkedIn URL, then by name key. Read-only, over the reply
 * already stored as evidence.
 */
function indexedEmployer(
	items: readonly RawItem[],
	candidateUrl: string | null,
	candidateName: string | null,
): string | null {
	const parsed = IndexReplySchema.safeParse(itemBody(items, "verify-index"));
	if (!parsed.success) return null;
	const results = parsed.data.results ?? [];
	const targetUrl = canonicalPersonUrl(candidateUrl);
	const targetKey = nameKey(candidateName);
	const byUrl = targetUrl
		? results.find(
				(result) => canonicalPersonUrl(result.url ?? null) === targetUrl,
			)
		: undefined;
	const match =
		byUrl ??
		(targetKey
			? results.find(
					(result) => nameKey(result.person?.fullName ?? null) === targetKey,
				)
			: undefined);
	const current = match?.person?.workHistory?.find(
		(entry) => entry.current === true,
	);
	return current?.companyName ?? null;
}

function pickFromItems(
	items: readonly RawItem[],
	candidate: { name: string | null; title: string | null; url: string | null },
	verified: boolean,
): PickTraceRecord {
	return {
		name: candidate.name,
		title: candidate.title,
		verified,
		verdict: verdictOf(items),
		indexEmployer: indexedEmployer(items, candidate.url, candidate.name),
		agreement: agreementOf(items),
		quoteCheck: quoteCheckOf(items),
	};
}

const PICK_BOUNDARY_KINDS = new Set(["verify-start", "verify-error"]);

/**
 * Splits one company's un-linked, run-company-scoped verify evidence into
 * pick-sized groups, best-effort: a new group starts at every `verify-start`
 * or `verify-error`, mirroring the order `verifyPick` (src/workflows/find-people-verify.ts)
 * writes them in. Two unverified picks for the same company cannot be told
 * apart by anything sturdier than this ordering — see `docs/solutions/eval.md`.
 */
function groupUnlinkedPicks(items: readonly RawItem[]): RawItem[][] {
	const groups: RawItem[][] = [];
	for (const item of items) {
		if (groups.length === 0 || PICK_BOUNDARY_KINDS.has(item.kind)) {
			groups.push([]);
		}
		groups.at(-1)?.push(item);
	}
	return groups;
}

function toRawItem(row: z.infer<typeof EvidenceRowSchema>): RawItem {
	return { kind: row.kind, body: parseJson(row.value) };
}

function personEnvelope(
	row: z.infer<typeof EvidenceRowSchema>,
): { runCompanyId: string; item: RawItem } | null {
	const parsed = PersonEvidenceEnvelopeSchema.safeParse(parseJson(row.value));
	if (!parsed.success) return null;
	return {
		runCompanyId: parsed.data.runCompanyId,
		item: { kind: row.kind, body: parsed.data.body },
	};
}

type EvidenceByCompany = {
	unlinked: Map<string, RawItem[]>;
	byPerson: Map<string, RawItem[]>;
};

function pushItem(
	map: Map<string, RawItem[]>,
	key: string,
	item: RawItem,
): void {
	const list = map.get(key) ?? [];
	list.push(item);
	map.set(key, list);
}

function bucketOneRow(
	row: z.infer<typeof EvidenceRowSchema>,
	buckets: EvidenceByCompany,
): void {
	if (row.subjectType === "run_company" && row.kind.startsWith("verify-")) {
		pushItem(buckets.unlinked, row.subjectId, toRawItem(row));
		return;
	}
	if (row.subjectType !== "person") return;
	const envelope = personEnvelope(row);
	if (!envelope) return;
	pushItem(
		buckets.byPerson,
		`${envelope.runCompanyId}:${row.subjectId}`,
		envelope.item,
	);
}

function bucketEvidence(
	rows: readonly z.infer<typeof EvidenceRowSchema>[],
): EvidenceByCompany {
	const buckets: EvidenceByCompany = {
		unlinked: new Map(),
		byPerson: new Map(),
	};
	for (const row of rows) bucketOneRow(row, buckets);
	return buckets;
}

export type PeopleCompanyTraceRecord = {
	domain: string;
	identity: string | null;
	mode: string | null;
	rosterSize: number;
	picks: PickTraceRecord[];
};

function picksForCompany(
	runCompanyId: string,
	persons: readonly z.infer<typeof PersonRowSchema>[],
	evidence: EvidenceByCompany,
): PickTraceRecord[] {
	const verified = persons
		.map((person) => {
			const items = evidence.byPerson.get(`${runCompanyId}:${person.id}`);
			return items
				? pickFromItems(
						items,
						{ name: person.name, title: person.title, url: person.linkedinUrl },
						true,
					)
				: null;
		})
		.filter((pick): pick is PickTraceRecord => pick !== null);
	const unlinked = groupUnlinkedPicks(evidence.unlinked.get(runCompanyId) ?? [])
		.filter((group) => group.length > 0)
		.map((group) =>
			pickFromItems(group, { name: null, title: null, url: null }, false),
		);
	return [...verified, ...unlinked];
}

/**
 * Every company a people run touched: its identity, roster size, and every
 * pick's verdict, indexed employer, cross-source agreement and quote check.
 * Reads `run_company`, `person` and `evidence` alone; a roster-mode company
 * carries no picks since it never runs the buyer verification pipeline.
 */
export async function readPeopleTraceRecords(
	sql: Sql,
	runId: string,
): Promise<PeopleCompanyTraceRecord[]> {
	const runCompanyRows = await sql`
		select id, domain, company_id as "companyId", identity, mode,
			people_roster as "peopleRoster"
		from run_company where run_id = ${runId} order by domain`;
	const companies = runCompanyRows.map((row) => RunCompanyRowSchema.parse(row));
	if (companies.length === 0) return [];
	const companyIds = companies
		.map((company) => company.companyId)
		.filter((id): id is string => id !== null);
	const personRows =
		companyIds.length > 0
			? await sql`
				select id, company_id as "companyId", linkedin_url as "linkedinUrl", name, title
				from person where company_id = any(${companyIds})`
			: [];
	const persons = personRows.map((row) => PersonRowSchema.parse(row));
	const runCompanyIds = companies.map((company) => company.id);
	const evidenceRows = await sql`
		select subject_type as "subjectType", subject_id as "subjectId", kind, value
		from evidence
		where (subject_type = 'run_company' and subject_id = any(${runCompanyIds}))
			or subject_type = 'person'`;
	const evidence = bucketEvidence(
		evidenceRows.map((row) => EvidenceRowSchema.parse(row)),
	);
	return companies.map((company) => ({
		domain: company.domain,
		identity: company.identity,
		mode: company.mode,
		rosterSize: company.peopleRoster,
		picks:
			company.mode === "roster"
				? []
				: picksForCompany(
						company.id,
						persons.filter((person) => person.companyId === company.companyId),
						evidence,
					),
	}));
}
