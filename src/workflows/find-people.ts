import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import { companiesForDomains } from "@/core/db/company-domains";
import { knownPeopleDomains } from "@/core/db/known-people";
import {
	accountSpendToday,
	appendEvidence,
	closeRun,
	companiesForRun,
	findRun,
	loadIcp,
	openRun,
	savePeople,
} from "@/core/db/queries";
import type { NewEvidence, NewPerson } from "@/core/db/schema";
import { normalizeDomain } from "@/core/db/schema";
import type {
	CompanyPeopleResult,
	FindPeopleDeps,
	FindPeopleOptions,
	FindPeopleResult,
	PeopleCompany,
	PersonCandidate,
} from "@/core/people";
import {
	decisionMakerTitles,
	findPeople,
	resolveMaxCompanies,
	splitKnownCompanies,
	toPersonData,
	truncateCompanies,
} from "@/core/people";
import { apolloPeopleSearch } from "@/core/providers/apollo";
import { search } from "@/core/providers/exa";
import { IcpDocSchema } from "@/core/synthesize";

const BATCH_SIZE = config.people.batchSize;
const EVIDENCE_SOURCE_EXA = "exa";
const EVIDENCE_SOURCE_TARGET = "target";

const maxCompaniesField = z.number().int().positive().optional();

const FindPeoplePayloadSchema = z.union([
	z.object({ runId: z.string().min(1), maxCompanies: maxCompaniesField }),
	z.object({
		domains: z.array(z.string().min(1)).min(1),
		maxCompanies: maxCompaniesField,
	}),
]);

type FindPeoplePayload = z.infer<typeof FindPeoplePayloadSchema>;

type FindPeopleWorkflowResult = FindPeopleResult & {
	unknownDomains: string[];
	knownDomains: string[];
};

/**
 * What the workflow reports back: counts and spend. The per-company row
 * arrays stay in Postgres, read back a page at a time through
 * `GET /runs/{runId}/people`.
 */
export type FindPeopleSummary = {
	searched: number;
	skippedCompanies: number;
	peopleFound: number;
	costDollars: number;
	unknownDomains: string[];
	knownDomains: string[];
};

function summarizeFindPeople(
	result: FindPeopleWorkflowResult,
): FindPeopleSummary {
	return {
		searched: result.searched,
		skippedCompanies: result.skippedCompanies,
		peopleFound: result.companies.reduce(
			(sum, company) => sum + company.people.length,
			0,
		),
		costDollars: result.costDollars,
		unknownDomains: result.unknownDomains,
		knownDomains: result.knownDomains,
	};
}

const PRODUCTION_DEPS: FindPeopleDeps = {
	decisionMakerTitles,
	search,
	apolloSearch: apolloPeopleSearch.run,
};

export type TargetCompanies = {
	companies: PeopleCompany[];
	icpId: string;
	unknownDomains: string[];
};

async function targetByRun(env: Env, runId: string): Promise<TargetCompanies> {
	const runRow = await findRun(env, runId);
	if (!runRow) {
		throw new NonRetryableError(`findPeople: unknown run ${runId}`);
	}
	const companies = await companiesForRun(env, runId);
	return { companies, icpId: runRow.icpId, unknownDomains: [] };
}

async function targetByDomains(
	env: Env,
	domains: readonly string[],
): Promise<TargetCompanies> {
	const matches = await companiesForDomains(env, domains);
	if (matches.length === 0) {
		throw new NonRetryableError(
			`findPeople: no known company for domains ${domains.join(", ")}`,
		);
	}
	const byDomain = new Map(matches.map((row) => [row.domain, row]));
	const icpId = matches[0]?.icpId;
	if (icpId === undefined) {
		throw new NonRetryableError(
			"findPeople: no known company for the given domains",
		);
	}
	return {
		companies: [...byDomain.values()].map(({ id, domain, name, exaId }) => ({
			id,
			domain,
			name,
			exaId,
		})),
		icpId,
		unknownDomains: domains.filter((domain) => !byDomain.has(domain)),
	};
}

/** Resolves the companies a people run searches, from a companies run id or a domain list. */
export function loadTargetCompanies(
	env: Env,
	payload: FindPeoplePayload,
): Promise<TargetCompanies> {
	return "runId" in payload
		? targetByRun(env, payload.runId)
		: targetByDomains(env, payload.domains);
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
		data: toPersonData(person.entity, person.result, EVIDENCE_SOURCE_EXA),
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
		const batchResult = await step.do(
			`people-batch-${index}`,
			config.stepConfig.paidCall,
			() => findPeople(batch, opts, PRODUCTION_DEPS),
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
	): Promise<FindPeopleSummary> {
		const payload = FindPeoplePayloadSchema.parse(event.payload);

		const target = await step.do(
			"load-companies",
			config.stepConfig.databaseCall,
			() => loadTargetCompanies(this.env, payload),
		);

		const { doc: icp, accountId } = await step.do(
			"load-icp",
			config.stepConfig.databaseCall,
			async () => {
				const icpRow = await loadIcp(this.env, target.icpId);
				if (!icpRow) {
					throw new NonRetryableError(
						`findPeople: unknown icp ${target.icpId}`,
					);
				}
				return {
					doc: IcpDocSchema.parse(icpRow.doc),
					accountId: icpRow.accountId,
				};
			},
		);

		await step.do("daily-ceiling", config.stepConfig.databaseCall, async () => {
			const spent = await accountSpendToday(this.env, accountId);
			if (spent >= config.spend.perAccountDailyDollars) {
				throw new NonRetryableError(
					`daily ceiling reached for this account: ${spent} of ${config.spend.perAccountDailyDollars} dollars`,
				);
			}
			return { spent };
		});

		await step.do("open-run", config.stepConfig.databaseCall, () =>
			openRun(this.env, {
				id: event.instanceId,
				accountId,
				icpId: target.icpId,
				capability: "people",
				status: "running",
			}),
		);

		const known = await step.do(
			"known-people",
			config.stepConfig.databaseCall,
			() =>
				knownPeopleDomains(this.env, accountId, {
					days: config.people.seenPeopleWindowDays,
				}),
		);
		const filtered = splitKnownCompanies(
			target.companies,
			new Set(known.map(normalizeDomain)),
		);

		const effectiveMax = resolveMaxCompanies(payload.maxCompanies);
		const { companies: scoped, skipped } = truncateCompanies(
			filtered.companies,
			effectiveMax,
		);
		const opts: FindPeopleOptions = { icp, env: this.env };
		const batches = await runBatches(toBatches(scoped), opts, step);
		const result: FindPeopleWorkflowResult = {
			...mergeResults(batches, skipped),
			unknownDomains: target.unknownDomains,
			knownDomains: filtered.skipped,
		};

		await step.do("save-people", config.stepConfig.databaseCall, () =>
			persistPeople(this.env, scoped, result.companies),
		);

		await step.do("close-run", config.stepConfig.databaseCall, () =>
			closeRun(this.env, event.instanceId, {
				status: "complete",
				costDollars: result.costDollars,
			}),
		);

		return summarizeFindPeople(result);
	}
}
