import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import { toBatches } from "@/core/batches";
import { knownPeopleDomains } from "@/core/db/known-people";
import {
	appendEvidence,
	closeRun,
	loadIcp,
	openRun,
	organizationSpendToday,
	recordRunSpend,
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
	PeopleSearchPlan,
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
import { apolloPeopleSearch } from "@/core/providers/apollo/index";
import { search } from "@/core/providers/exa/search";
import type { IcpDoc } from "@/core/synthesize";
import { IcpDocSchema } from "@/core/synthesize";
import { agentPersonSearch } from "@/workflows/find-people-agent";
import { loadTargetCompanies } from "@/workflows/find-people-target";

const BATCH_SIZE = config.people.batchSize;
const EVIDENCE_SOURCE_EXA = "exa";
const EVIDENCE_SOURCE_TARGET = "target";
const PEOPLE_SOURCE: "exa-search" | "exa-agent" = config.people.peopleSource;

const maxCompaniesField = z.number().int().positive().optional();

const FindPeoplePayloadSchema = z.union([
	z.object({
		runId: z.string().min(1),
		maxCompanies: maxCompaniesField,
		organizationId: z.string().min(1),
	}),
	z.object({
		domains: z.array(z.string().min(1)).min(1),
		maxCompanies: maxCompaniesField,
		organizationId: z.string().min(1),
	}),
]);

export type FindPeoplePayload = z.infer<typeof FindPeoplePayloadSchema>;

type FindPeopleWorkflowResult = FindPeopleResult & {
	unknownDomains: string[];
	knownDomains: string[];
	capped: boolean;
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
	capped: boolean;
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
		capped: result.capped,
	};
}

/**
 * Builds the dependencies one people batch runs with. The search dependency
 * branches on the configured people source; every other dependency stays
 * the same regardless of source.
 */
function batchDeps(step: WorkflowStep, batchIndex: number): FindPeopleDeps {
	const isAgent = PEOPLE_SOURCE === "exa-agent";
	return {
		search: isAgent
			? agentPersonSearch(step, batchIndex)
			: (_company, req, env, ledger) => search(req, env, ledger),
		apolloSearch: apolloPeopleSearch.run,
	};
}

/** Splits `companies` into ordered groups of `BATCH_SIZE`, for one durable step each. */
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

function toNewPerson(
	person: PersonCandidate,
	companyId: string,
	organizationId: string,
): NewPerson {
	return {
		organizationId,
		companyId,
		linkedinUrl: person.linkedinUrl,
		name: person.fullName,
		title: person.title,
		data: toPersonData(person, EVIDENCE_SOURCE_EXA),
	};
}

function collectNewPeople(
	companies: readonly PeopleCompany[],
	results: readonly CompanyPeopleResult[],
	organizationId: string,
): { rows: NewPerson[]; byUrl: Map<string, PersonCandidate> } {
	const byDomain = companyByDomain(companies);
	const byUrl = new Map<string, PersonCandidate>();
	const rows: NewPerson[] = [];
	for (const result of results) {
		const matchedCompany = byDomain.get(result.domain);
		if (!matchedCompany) continue;
		for (const person of result.people) {
			byUrl.set(person.linkedinUrl, person);
			rows.push(toNewPerson(person, matchedCompany.id, organizationId));
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
	organizationId: string,
): Promise<void> {
	const { rows, byUrl } = collectNewPeople(companies, results, organizationId);
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
	runId: string,
): Promise<{ batches: FindPeopleResult[]; capped: boolean }> {
	const results: FindPeopleResult[] = [];
	let costDollars = 0;
	for (const [index, batch] of batches.entries()) {
		const batchResult = await step.do(
			`people-batch-${index}`,
			config.stepConfig.paidCall,
			() => findPeople(batch, opts, batchDeps(step, index)),
		);
		results.push(batchResult);
		costDollars += batchResult.costDollars;
		await step.do(
			`people-batch-${index}-spend`,
			config.stepConfig.databaseCall,
			() => recordRunSpend(opts.env, runId, costDollars),
		);
		if (costDollars >= config.spend.perRunDollars) {
			return { batches: results, capped: index < batches.length - 1 };
		}
	}
	return { batches: results, capped: false };
}

/**
 * The titles and query one run searches with, resolved once. They depend only
 * on the profile, so a call per batch would pay a model for the same answer
 * as many times as the run has batches.
 */
async function resolvePlan(
	icp: IcpDoc,
	env: Env,
	step: WorkflowStep,
): Promise<PeopleSearchPlan & { costDollars: number }> {
	return step.do("people-plan", config.stepConfig.paidCall, async () => {
		const result = await decisionMakerTitles(icp, env);
		return {
			titles: result.titles,
			queryTemplate: result.queryTemplate,
			userLocation: result.userLocation,
			costDollars: result.ledger.total(),
		};
	});
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

		const { doc: icp } = await step.do(
			"load-icp",
			config.stepConfig.databaseCall,
			async () => {
				const icpRow = await loadIcp(this.env, target.icpId);
				if (!icpRow) {
					throw new NonRetryableError(
						`findPeople: unknown icp ${target.icpId}`,
					);
				}
				if (icpRow.organizationId !== payload.organizationId) {
					throw new NonRetryableError(
						`findPeople: icp ${target.icpId} does not belong to organization ${payload.organizationId}`,
					);
				}
				return { doc: IcpDocSchema.parse(icpRow.doc) };
			},
		);
		const organizationId = payload.organizationId;

		await step.do("open-run", config.stepConfig.databaseCall, async () => {
			const spent = await organizationSpendToday(this.env, organizationId);
			if (spent >= config.spend.perAccountDailyDollars) {
				throw new NonRetryableError(
					`daily ceiling reached for this account: ${spent} of ${config.spend.perAccountDailyDollars} dollars`,
				);
			}
			return openRun(this.env, {
				id: event.instanceId,
				organizationId,
				icpId: target.icpId,
				capability: "people",
				status: "running",
			});
		});

		const known = await step.do(
			"known-people",
			config.stepConfig.databaseCall,
			() =>
				knownPeopleDomains(this.env, organizationId, {
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
		const resolved = await resolvePlan(icp, this.env, step);
		const opts: FindPeopleOptions = { icp, env: this.env, plan: resolved };
		const run = await runBatches(
			toBatches(scoped, BATCH_SIZE),
			opts,
			step,
			event.instanceId,
		);
		const merged = mergeResults(run.batches, skipped);
		const result: FindPeopleWorkflowResult = {
			...merged,
			costDollars: merged.costDollars + resolved.costDollars,
			unknownDomains: target.unknownDomains,
			knownDomains: filtered.skipped,
			capped: run.capped,
		};

		await step.do("save-people", config.stepConfig.databaseCall, () =>
			persistPeople(this.env, scoped, result.companies, organizationId),
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
