import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import { appendEvidence, upsertPeople } from "@/core/db/queries";
import type { Candidate } from "@/core/people/candidate";
import { groupCandidates, prefilterBuyers } from "@/core/people/filter";
import {
	peopleSearchRequest,
	type ResearchPerson,
	searchSubject,
} from "@/core/people/research";
import {
	PersonDataSchema,
	personVerifyEvidenceRow,
	rawEvidenceRow,
	toNewPerson,
} from "@/core/people/rows";
import { search } from "@/core/providers/exa/search";
import type {
	CompanyLoopContext,
	CompanyProgress,
} from "@/workflows/find-people-company";
import { runResearchBatch } from "@/workflows/find-people-research";
import {
	buyPeopleStep,
	canPurchase,
	recordPeopleEvidence,
} from "@/workflows/find-people-spend";

async function eligibleBuyers(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	candidates: readonly Candidate[],
): Promise<Candidate[][]> {
	if (candidates.length <= 1) return candidates.length ? [[...candidates]] : [];
	const filteredBatches: Awaited<ReturnType<typeof prefilterBuyers>>[] = [];
	for (let offset = 0; offset < candidates.length; offset += 100) {
		const filtered = await buyPeopleStep(
			ctx,
			progress,
			`prefilter-${offset}`,
			(ledger) =>
				prefilterBuyers(
					{
						company: progress.company,
						buyer: ctx.buyer,
						candidates: candidates.slice(offset, offset + 100),
						researchAll: candidates.length <= 25,
						bands: [
							...new Set(
								filteredBatches.flatMap((batch) =>
									batch.assignments.map((row) => row.band),
								),
							),
						],
					},
					ctx.env,
					ledger,
				),
		);
		filteredBatches.push(filtered);
	}
	return groupCandidates(
		filteredBatches.flatMap((batch) => batch.candidates),
		filteredBatches.flatMap((batch) => batch.assignments),
	).flatMap((group) => {
		const batches: Candidate[][] = [];
		for (let at = 0; at < group.length; at += config.people.researchBatchSize)
			batches.push(group.slice(at, at + config.people.researchBatchSize));
		return batches;
	});
}

async function saveDecision(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	person: {
		candidate: Candidate;
		result: ResearchPerson;
		source: "search" | "agent" | "pending";
	},
): Promise<boolean> {
	const { candidate, result } = person;
	if (result.decision === "rejected") return false;
	const verified = result.decision === "verified";
	const resolved = verified
		? {
				...candidate,
				name: result.name,
				title: result.title,
				url: result.linkedinUrl,
			}
		: candidate;
	return ctx.step.do(
		`people-${progress.company.domain}-person-${candidate.id}-save`,
		config.stepConfig.databaseCall,
		async () => {
			const row = toNewPerson(
				resolved,
				{ companyId: progress.companyId, organizationId: ctx.organizationId },
				verified ? "verified" : "pending",
				result.reason,
			);
			if (!row) return false;
			row.data = {
				...PersonDataSchema.parse(row.data),
				buyerFit: result.buyerFit,
			};
			const [saved] = await upsertPeople(ctx.env, [row]);
			if (!saved) return false;
			await appendEvidence(ctx.env, [
				personVerifyEvidenceRow({
					personId: saved.id,
					runCompanyId: progress.runCompanyId,
					kind: `verify-${person.source}`,
					source: person.source === "pending" ? "engine" : "exa",
					body: person,
				}),
			]);
			return true;
		},
	);
}

async function searchPerson(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	candidate: Candidate,
): Promise<ResearchPerson | null> {
	const name = `search-${candidate.id}`;
	const request = peopleSearchRequest(candidate);
	const result = await buyPeopleStep(ctx, progress, name, async (ledger) => {
		try {
			const reply = await search(request, ctx.env, ledger);
			return {
				request: JSON.stringify(request),
				reply: JSON.stringify(reply),
				person: searchSubject(candidate, reply),
				error: null,
				billingUnknown: false,
			};
		} catch (error) {
			return {
				request: JSON.stringify(request),
				reply: null,
				person: null,
				error: error instanceof Error ? error.message : String(error),
				billingUnknown: ledger.total() === 0,
			};
		}
	});
	if (result.billingUnknown) {
		progress.billingUnknown = true;
		progress.capped = true;
		await recordPeopleEvidence(ctx, progress, `${name}-billing-unknown`, {
			billingUnknown: true,
			reservedDollars: 0.05,
			reportedCostDollars: null,
			error: result.error,
		});
		throw new NonRetryableError("Search billing remains unknown");
	}
	return result.person;
}

async function completeDecision(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	person: {
		candidate: Candidate;
		result: ResearchPerson;
		source: "search" | "agent" | "pending";
	},
	delivered: Set<string>,
): Promise<void> {
	if (person.source !== "pending") progress.checked++;
	if (person.source === "search") progress.researched++;
	if (person.result.decision === "rejected") return;
	if (!(await saveDecision(ctx, progress, person))) {
		progress.capped = true;
		return;
	}
	if (person.result.decision === "verified" && person.result.linkedinUrl)
		delivered.add(person.result.linkedinUrl);
	else progress.roster++;
	progress.verified = delivered.size;
}

function pendingDecision(candidate: Candidate): ResearchPerson {
	return {
		id: candidate.id,
		decision: "unresolved",
		identityStatus: "unresolved",
		currentEmployerStatus: "unresolved",
		currentRoleStatus: "unresolved",
		buyerFit: "unresolved",
		name: null,
		title: null,
		linkedinUrl: null,
		roleEvidence: null,
		reason:
			"Search did not establish a supported decision and Agent fallback did not return a valid result.",
	};
}

async function verifyFallback(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	batch: { candidates: Candidate[]; index: number; delivered: Set<string> },
): Promise<void> {
	let researched: ResearchPerson[] = [];
	try {
		researched = await runResearchBatch(
			ctx,
			progress,
			batch.candidates,
			batch.index,
		);
	} catch (error) {
		progress.capped = true;
		await recordPeopleEvidence(ctx, progress, `fallback-${batch.index}-error`, {
			message: error instanceof Error ? error.message : String(error),
		});
	}
	for (const candidate of batch.candidates) {
		const result = researched.find((person) => person.id === candidate.id);
		await completeDecision(
			ctx,
			progress,
			{
				candidate,
				result: result ?? pendingDecision(candidate),
				source: result ? "agent" : "pending",
			},
			batch.delivered,
		);
	}
	if (progress.billingUnknown)
		throw new NonRetryableError("Agent billing remains unknown");
}

async function verifyBatch(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	batch: { candidates: Candidate[]; index: number; delivered: Set<string> },
): Promise<void> {
	const fallback: Candidate[] = [];
	for (const candidate of batch.candidates) {
		if (!canPurchase(progress)) break;
		const result = await searchPerson(ctx, progress, candidate);
		if (!result || result.decision === "unresolved") fallback.push(candidate);
		else
			await completeDecision(
				ctx,
				progress,
				{ candidate, result, source: "search" },
				batch.delivered,
			);
	}
	if (fallback.length)
		await verifyFallback(ctx, progress, { ...batch, candidates: fallback });
}

/** Searches every selected person, using Agent only for unresolved decisions and retaining pending people. */
export async function runBuyerMode(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
	candidates: readonly Candidate[],
): Promise<void> {
	progress.eligible = candidates.length;
	const batches = await eligibleBuyers(ctx, progress, candidates);
	progress.eligible = batches.reduce((total, batch) => total + batch.length, 0);
	const delivered = new Set<string>();
	for (const [index, batch] of batches.entries()) {
		if (!canPurchase(progress)) {
			progress.capped = true;
			break;
		}
		await verifyBatch(ctx, progress, {
			candidates: batch,
			index,
			delivered,
		});
	}
	progress.capped ||= progress.checked < progress.eligible;
	await ctx.step.do(
		`people-${progress.company.domain}-verification-counts`,
		config.stepConfig.databaseCall,
		() =>
			appendEvidence(ctx.env, [
				rawEvidenceRow(progress.runCompanyId, "verification-counts", "engine", {
					eligible: progress.eligible,
					researched: progress.researched,
					checked: progress.checked,
					delivered: [...delivered],
					capped: progress.capped,
				}),
			]),
	);
}
