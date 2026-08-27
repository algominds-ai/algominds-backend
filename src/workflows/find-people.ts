import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type { DbFactory } from "@/core/db/queries";
import { appendEvidence, loadIcp, savePeople } from "@/core/db/queries";
import type { NewEvidence, NewPerson } from "@/core/db/schema";
import { company } from "@/core/db/schema";
import type {
	CompanyPeopleResult,
	FindPeopleDeps,
	FindPeopleOptions,
	FindPeopleResult,
	PeopleCompany,
	PersonCandidate,
} from "@/core/people";
import {
	DEFAULT_MAX_COMPANIES,
	decisionMakerTitles,
	findPeople,
	truncateCompanies,
} from "@/core/people";
import { apolloPeopleSearch } from "@/core/providers/apollo";
import { search } from "@/core/providers/exa";
import { IcpDocSchema } from "@/core/synthesize";

const BATCH_SIZE = 5;
const EVIDENCE_SOURCE_EXA = "exa";
const EVIDENCE_SOURCE_TARGET = "target";

const FindPeoplePayloadSchema = z.object({
	icpId: z.string(),
	maxCompanies: z.number().int().positive().optional(),
});

type FindPeoplePayload = z.infer<typeof FindPeoplePayloadSchema>;

const PRODUCTION_DEPS: FindPeopleDeps = {
	decisionMakerTitles,
	search,
	apolloSearch: apolloPeopleSearch.run,
};

type CompanyColumns = {
	id: typeof company.id;
	domain: typeof company.domain;
	name: typeof company.name;
};

interface CompanyIcpConnection {
	select(columns: CompanyColumns): {
		from(table: typeof company): {
			where(condition: unknown): Promise<PeopleCompany[]>;
		};
	};
}

/** The columns a Workflow step can safely return: no jsonb `data`, no `Date`. */
async function companiesForIcp(
	env: DbEnv,
	icpId: string,
	buildDb: DbFactory<CompanyIcpConnection> = db,
): Promise<PeopleCompany[]> {
	const connection = buildDb(env, "cached");
	return connection
		.select({ id: company.id, domain: company.domain, name: company.name })
		.from(company)
		.where(eq(company.icpId, icpId));
}

/** Splits `companies` into ordered groups of `BATCH_SIZE`, for one durable step each. */
export function toBatches(
	companies: readonly PeopleCompany[],
): PeopleCompany[][] {
	const batches: PeopleCompany[][] = [];
	for (let start = 0; start < companies.length; start += BATCH_SIZE) {
		batches.push(companies.slice(start, start + BATCH_SIZE));
	}
	return batches;
}

function mergeResults(
	batches: readonly FindPeopleResult[],
	skippedCompanies: number,
): FindPeopleResult {
	return {
		companies: batches.flatMap((batch) => batch.companies),
		searched: batches.reduce((sum, batch) => sum + batch.searched, 0),
		skippedCompanies,
		costDollars: batches.reduce((sum, batch) => sum + batch.costDollars, 0),
	};
}

function companyByDomain(
	companies: readonly PeopleCompany[],
): Map<string, PeopleCompany> {
	return new Map(companies.map((row) => [row.domain, row]));
}

function toNewPerson(person: PersonCandidate, companyId: string): NewPerson {
	return {
		companyId,
		linkedinUrl: person.linkedinUrl,
		name: person.fullName,
		title: person.title,
		data: {
			rawTitle: person.rawTitle,
			location: person.location,
			apolloMatched: person.apolloMatched,
		},
	};
}

function collectNewPeople(
	companies: readonly PeopleCompany[],
	results: readonly CompanyPeopleResult[],
): { rows: NewPerson[]; byUrl: Map<string, PersonCandidate> } {
	const byDomain = companyByDomain(companies);
	const byUrl = new Map<string, PersonCandidate>();
	const rows: NewPerson[] = [];
	for (const result of results) {
		const matchedCompany = byDomain.get(result.domain);
		if (!matchedCompany) continue;
		for (const person of result.people) {
			byUrl.set(person.linkedinUrl, person);
			rows.push(toNewPerson(person, matchedCompany.id));
		}
	}
	return { rows, byUrl };
}

function evidenceRowsForPerson(
	subjectId: string,
	person: PersonCandidate,
): NewEvidence[] {
	const rows: NewEvidence[] = [
		{
			subjectType: "person",
			subjectId,
			kind: "fullName",
			value: person.fullName,
			source: EVIDENCE_SOURCE_EXA,
		},
	];
	if (person.rawTitle !== null) {
		rows.push({
			subjectType: "person",
			subjectId,
			kind: "rawHeadline",
			value: person.rawTitle,
			source: EVIDENCE_SOURCE_EXA,
		});
	}
	if (person.title !== null) {
		rows.push({
			subjectType: "person",
			subjectId,
			kind: "title",
			value: person.title,
			source: EVIDENCE_SOURCE_EXA,
		});
	}
	if (person.location !== null) {
		rows.push({
			subjectType: "person",
			subjectId,
			kind: "location",
			value: person.location,
			source: EVIDENCE_SOURCE_EXA,
		});
	}
	for (const claim of person.employment) {
		rows.push({
			subjectType: "person",
			subjectId,
			kind: "employer",
			value: claim.company,
			source:
				claim.source === "exa" ? EVIDENCE_SOURCE_EXA : EVIDENCE_SOURCE_TARGET,
			confidence: claim.confidence,
		});
	}
	return rows;
}

async function persistPeople(
	env: Env,
	companies: readonly PeopleCompany[],
	results: readonly CompanyPeopleResult[],
): Promise<void> {
	const { rows, byUrl } = collectNewPeople(companies, results);
	const saved = await savePeople(env, rows);
	const evidenceRows = saved.flatMap((row) => {
		const candidate =
			row.linkedinUrl !== null ? byUrl.get(row.linkedinUrl) : undefined;
		return candidate ? evidenceRowsForPerson(row.id, candidate) : [];
	});
	await appendEvidence(env, evidenceRows);
}

async function runBatches(
	batches: readonly PeopleCompany[][],
	opts: FindPeopleOptions,
	step: WorkflowStep,
): Promise<FindPeopleResult[]> {
	const results: FindPeopleResult[] = [];
	for (const [index, batch] of batches.entries()) {
		const batchResult = await step.do(`people-batch-${index}`, () =>
			findPeople(batch, opts, PRODUCTION_DEPS),
		);
		results.push(batchResult);
	}
	return results;
}

export class FindPeopleWorkflow extends WorkflowEntrypoint<
	Env,
	FindPeoplePayload
> {
	override async run(
		event: Readonly<WorkflowEvent<FindPeoplePayload>>,
		step: WorkflowStep,
	): Promise<FindPeopleResult> {
		const payload = FindPeoplePayloadSchema.parse(event.payload);
		const icp = await step.do("load-icp", async () => {
			const icpRow = await loadIcp(this.env, payload.icpId);
			if (!icpRow) {
				throw new NonRetryableError(`findPeople: unknown icp ${payload.icpId}`);
			}
			return IcpDocSchema.parse(icpRow.doc);
		});
		const allCompanies = await step.do("load-companies", () =>
			companiesForIcp(this.env, payload.icpId),
		);
		const { companies: scoped, skipped } = truncateCompanies(
			allCompanies,
			payload.maxCompanies ?? DEFAULT_MAX_COMPANIES,
		);
		const opts: FindPeopleOptions = { icp, env: this.env };
		const batches = await runBatches(toBatches(scoped), opts, step);
		const result = mergeResults(batches, skipped);

		await step.do("save-people", () =>
			persistPeople(this.env, scoped, result.companies),
		);

		return result;
	}
}
