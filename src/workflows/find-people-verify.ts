import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger } from "@/core/cost";
import {
	appendEvidence,
	updateRunCompany,
	upsertPeople,
} from "@/core/db/queries";
import type { NewEvidence, NewPerson, Person } from "@/core/db/schema";
import type { Candidate } from "@/core/people/candidate";
import type { IdentityGroup } from "@/core/people/person-identity";
import { groupByPersonIdentity } from "@/core/people/person-identity";
import {
	personVerifyEvidenceRow,
	rawEvidenceRow,
	toNewPerson,
} from "@/core/people/rows";
import type { SelectedBuyer, SelectModelReply } from "@/core/people/select";
import { selectBuyers } from "@/core/people/select";
import type { VerdictClassification } from "@/core/people/verify";
import { classifyVerdict } from "@/core/people/verify";
import type {
	ExaAgentVerdict,
	VerdictRunInput,
} from "@/core/providers/exa/agent";
import {
	buildVerdictRunRequest,
	getAgentVerdictRun,
	startAgentRun,
} from "@/core/providers/exa/agent";
import { quoteOnPage } from "@/core/providers/exa/contents";
import { applyCostEntries, pollAgentRun } from "@/workflows/agent-poll";
import type {
	CompanyLoopContext,
	CompanyProgress,
	CompanyRunResult,
	RosterStepResult,
} from "@/workflows/find-people-company";
import { secondOpinion } from "@/workflows/find-people-second-opinion";
import { recordCompanySpend } from "@/workflows/find-people-spend";

async function runSelect(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	candidates: readonly Candidate[],
): Promise<{
	picks: SelectedBuyer[];
	droppedIds: number[];
	reply: SelectModelReply | null;
	costDollars: number;
}> {
	return ctx.step.do(
		`people-${progress.domain}-select`,
		config.stepConfig.paidCall,
		() => {
			const description = ctx.profile?.description ?? null;
			return selectBuyers(
				{
					description,
					buyer: ctx.buyer,
					candidates,
					company: {
						name: progress.companyName,
						workforceTotal: progress.workforceTotal,
					},
				},
				ctx.env,
			);
		},
	);
}

export type PickEvidence = { kind: string; body: unknown };

type PickOutcome = {
	verified: boolean;
	evidence: PickEvidence[];
	costEntries: CostEntry[];
};

export type PickContext = {
	ctx: CompanyLoopContext;
	progress: CompanyProgress;
	name: string;
	candidate: Candidate;
};

function verdictSubject(pick: PickContext): VerdictRunInput {
	return {
		name: pick.candidate.name ?? "",
		title: pick.candidate.title ?? "",
		company: pick.candidate.company ?? pick.progress.companyName,
		domain: pick.progress.domain,
	};
}

type QuoteCheck = {
	evidence: PickEvidence | null;
	costEntries: CostEntry[];
	missing: boolean;
};

type QuoteStepResult = {
	found: boolean;
	reason: string;
	costEntries: CostEntry[];
};

/**
 * Checks the verdict's quote against its own URL and reports the guard's
 * outcome as one `verify-quote` evidence item, so a later run can see why a
 * URL was, or was not, trusted. `missing` is true only when the page was read
 * cleanly and the quote was not on it, never on a crawl failure.
 */
async function checkEvidenceQuote(
	pick: PickContext,
	verdict: ExaAgentVerdict,
	verified: boolean,
): Promise<QuoteCheck> {
	if (!verified || !verdict.evidence_url || !verdict.evidence_quote) {
		return { evidence: null, costEntries: [], missing: false };
	}
	const url = verdict.evidence_url;
	const quote = verdict.evidence_quote;
	const outcome = await pick.ctx.step.do(
		`${pick.name}-quote`,
		config.stepConfig.paidCall,
		async (): Promise<QuoteStepResult> => {
			const stepLedger = new CostLedger();
			const result = await quoteOnPage(url, quote, pick.ctx.env, stepLedger);
			return {
				found: result.found,
				reason: result.reason,
				costEntries: stepLedger.toJSON().entries,
			};
		},
	);
	return {
		evidence: {
			kind: "verify-quote",
			body: { url, found: outcome.found, reason: outcome.reason },
		},
		costEntries: outcome.costEntries,
		missing: !outcome.found && outcome.reason === "missing",
	};
}

function verifyErrorOutcome(
	pollLedger: CostLedger,
	error: unknown,
): PickOutcome {
	const detail = error instanceof Error ? error : new Error(String(error));
	return {
		verified: false,
		evidence: [
			{
				kind: "verify-error",
				body: { name: detail.constructor.name, message: detail.message },
			},
		],
		costEntries: pollLedger.toJSON().entries,
	};
}

type VerdictResolution = { verified: boolean; evidence: PickEvidence[] };

/**
 * Turns a poll's verdict into a verified flag: a first-party or press
 * confirmation verifies outright unless its quote is checked and missing
 * from the page, in which case it falls to the same second opinion an
 * aggregator or LinkedIn confirmation always takes. A crawl failure on the
 * quote check leaves a first-party or press verdict verified as reported.
 */
async function resolveVerdict(
	pick: PickContext,
	verdict: ExaAgentVerdict,
	classification: VerdictClassification,
	ledger: CostLedger,
): Promise<VerdictResolution> {
	if (classification === "needs_index") {
		const opinion = await secondOpinion(pick, ledger);
		return { verified: opinion.verified, evidence: opinion.evidence };
	}
	const verified = classification === "verified";
	if (classification !== "verified") return { verified, evidence: [] };
	const quoteCheck = await checkEvidenceQuote(pick, verdict, verified);
	applyCostEntries(quoteCheck.costEntries, ledger);
	const evidence: PickEvidence[] = quoteCheck.evidence
		? [quoteCheck.evidence]
		: [];
	if (!quoteCheck.missing) return { verified, evidence };
	const opinion = await secondOpinion(pick, ledger);
	evidence.push(...opinion.evidence);
	return { verified: opinion.verified, evidence };
}

/**
 * Runs one candidate through the Exa verify agent. Whatever a pick's steps
 * finally throw once their own retries are exhausted is caught here and
 * turned into an unverified outcome with a `verify-error` evidence row, so
 * one stuck pick never aborts the run.
 */
async function verifyPick(pick: PickContext): Promise<PickOutcome> {
	const pollLedger = new CostLedger();
	try {
		const start = await pick.ctx.step.do(
			`${pick.name}-start`,
			config.stepConfig.paidCall,
			() =>
				startAgentRun(
					buildVerdictRunRequest(verdictSubject(pick)),
					pick.ctx.env,
				),
		);
		const verdict = await pollAgentRun(
			{
				env: pick.ctx.env,
				step: pick.ctx.step,
				name: pick.name,
				id: start.id,
				intervalSeconds: config.people.exaAgentPollIntervalSeconds,
				maxAttempts: config.people.exaAgentMaxPollAttempts,
			},
			pollLedger,
			(ledger) => getAgentVerdictRun(start.id, pick.ctx.env, ledger),
		);
		const classification = classifyVerdict(verdict, pick.progress.domain);
		const resolution = await resolveVerdict(
			pick,
			verdict,
			classification,
			pollLedger,
		);
		const evidence: PickEvidence[] = [
			{ kind: "verify-start", body: start },
			{ kind: "verify-poll", body: verdict },
			...resolution.evidence,
		];
		return {
			verified: resolution.verified,
			evidence,
			costEntries: pollLedger.toJSON().entries,
		};
	} catch (error) {
		return verifyErrorOutcome(pollLedger, error);
	}
}

type PickResult = { pick: SelectedBuyer; outcome: PickOutcome };

/** One group per identity among a company's verified picks: a canonical LinkedIn URL, or a matching normalized name, title and domain, groups two picks as the same person. */
function pickGroups(
	results: readonly PickResult[],
	domain: string,
): Array<IdentityGroup<PickResult>> {
	return groupByPersonIdentity(
		results.filter((result) => result.outcome.verified),
		(result) => result.pick.candidate,
		domain,
	);
}

function verifiedPersonRows(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	results: readonly PickResult[],
): NewPerson[] {
	const rows: NewPerson[] = [];
	for (const group of pickGroups(results, progress.domain)) {
		const { pick } = group.canonical;
		const row = toNewPerson(
			pick.candidate,
			{ companyId: progress.companyId, organizationId: ctx.organizationId },
			"verified",
			pick.basis,
		);
		if (row) rows.push(row);
	}
	return rows;
}

/** The saved person a pick's own candidate resolved to, or undefined when the pick was never verified or carried no LinkedIn URL to key it on. */
function personForPick(
	stored: readonly Person[],
	pick: SelectedBuyer,
): Person | undefined {
	const url = pick.candidate.url;
	return url ? stored.find((person) => person.linkedinUrl === url) : undefined;
}

/** One append-only "person-alias" evidence row for a candidate a company's other verified pick already delivered, carrying that duplicate's own LinkedIn URL on the person that was kept. */
function personAliasEvidenceRow(
	progress: CompanyProgress,
	person: Person | undefined,
	duplicate: PickResult,
): NewEvidence {
	const body = { url: duplicate.pick.candidate.url };
	return person
		? personVerifyEvidenceRow({
				personId: person.id,
				runCompanyId: progress.runCompanyId,
				kind: "person-alias",
				source: "engine",
				body,
			})
		: rawEvidenceRow(progress.runCompanyId, "person-alias", "engine", body);
}

function verifiedEvidenceRows(
	progress: CompanyProgress,
	reply: SelectModelReply | null,
	results: readonly PickResult[],
	stored: readonly Person[],
): NewEvidence[] {
	const rows: NewEvidence[] = [
		rawEvidenceRow(progress.runCompanyId, "select", "reasoningModel", reply),
	];
	for (const { pick, outcome } of results) {
		const person = personForPick(stored, pick);
		for (const item of outcome.evidence) {
			rows.push(
				person
					? personVerifyEvidenceRow({
							personId: person.id,
							runCompanyId: progress.runCompanyId,
							kind: item.kind,
							source: "exa",
							body: item.body,
						})
					: rawEvidenceRow(progress.runCompanyId, item.kind, "exa", item.body),
			);
		}
	}
	for (const group of pickGroups(results, progress.domain)) {
		const person = personForPick(stored, group.canonical.pick);
		for (const duplicate of group.duplicates) {
			rows.push(personAliasEvidenceRow(progress, person, duplicate));
		}
	}
	return rows;
}

async function saveVerifiedPeople(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	reply: SelectModelReply | null,
	results: readonly PickResult[],
): Promise<number> {
	return ctx.step.do(
		`people-${progress.domain}-save`,
		config.stepConfig.databaseCall,
		async () => {
			const stored = await upsertPeople(
				ctx.env,
				verifiedPersonRows(ctx, progress, results),
			);
			await updateRunCompany(ctx.env, progress.runCompanyId, {
				peopleVerified: stored.length,
				clayRecords: progress.clayRecords,
				spendDollars: progress.ledger.total(),
			});
			await appendEvidence(
				ctx.env,
				verifiedEvidenceRows(progress, reply, results, stored),
			);
			return stored.length;
		},
	);
}

/** Selects every candidate the rubric would have own the budget or the decision, verifies each with one Exa agent run bounded by `config.people.maxVerifyPerCompany`, and saves the verified people plus every collected reply. */
export async function runBuyerMode(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	roster: RosterStepResult,
): Promise<CompanyRunResult> {
	const select = await runSelect(ctx, progress, roster.candidates);
	progress.ledger.reported("select", "select", select.costDollars);
	const picks = select.picks.slice(0, config.people.maxVerifyPerCompany);
	const outcomes: PickOutcome[] = [];
	const width = config.people.verifyConcurrency;
	for (let at = 0; at < picks.length; at += width) {
		const chunk = picks.slice(at, at + width);
		outcomes.push(
			...(await Promise.all(
				chunk.map((pick, offset) =>
					verifyPick({
						ctx,
						progress,
						name: `people-${progress.domain}-verify-${at + offset}`,
						candidate: pick.candidate,
					}),
				),
			)),
		);
	}
	const results: PickResult[] = [];
	for (let i = 0; i < picks.length; i++) {
		const pick = picks[i];
		const outcome = outcomes[i];
		if (!pick || !outcome) continue;
		applyCostEntries(outcome.costEntries, progress.ledger);
		results.push({ pick, outcome });
	}
	const verifiedCount = await saveVerifiedPeople(
		ctx,
		progress,
		select.reply,
		results,
	);
	const costDollars = await recordCompanySpend(ctx, progress);
	return {
		outcome: { verified: verifiedCount, roster: 0, unresolvedDomain: null },
		costDollars,
	};
}
