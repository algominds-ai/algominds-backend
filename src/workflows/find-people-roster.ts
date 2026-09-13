import type { Candidate } from "@/core/people/candidate";
import { type DedupeRow, dedupe } from "@/core/people/dedupe";
import { type ClaySearchResult, claySearch } from "@/core/providers/clay";
import { exaPeopleRoster } from "@/core/providers/exa/people-roster";
import type {
	CompanyLoopContext,
	CompanyProgress,
} from "@/workflows/find-people-company";
import { resolveCompanyContext } from "@/workflows/find-people-company";
import {
	buyPeopleStep,
	recordPeopleEvidence,
} from "@/workflows/find-people-spend";

async function fallbackRoster(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
): Promise<DedupeRow[]> {
	if (!progress.company.exaId) await resolveCompanyContext(ctx, progress);
	const organizationId = progress.company.exaId;
	if (!organizationId) {
		progress.capped = true;
		await recordPeopleEvidence(ctx, progress, "fallback-unavailable", {
			reason: "No exact employer entity identifier",
		});
		return [];
	}
	const result = await buyPeopleStep(ctx, progress, "fallback", (ledger) =>
		exaPeopleRoster(ctx.env, progress.company, organizationId, ledger),
	);
	progress.capped ||= result.capped;
	return result.rows;
}

async function clayRoster(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
): Promise<ClaySearchResult | null> {
	try {
		const result = await buyPeopleStep(ctx, progress, "clay", (ledger) =>
			claySearch(
				ctx.env,
				{ identifier: progress.company.linkedinUrl ?? progress.company.domain },
				ledger,
			),
		);
		progress.clayRecords += result.quotaUsed;
		progress.capped ||= result.capped;
		return result;
	} catch (error) {
		progress.capped = true;
		await recordPeopleEvidence(ctx, progress, "clay-error", {
			message: String(error),
		});
		return null;
	}
}

/** Pages one unfiltered company roster and falls back once when Clay is empty or incomplete. */
export async function collectCompanyRoster(
	ctx: CompanyLoopContext,
	progress: CompanyProgress,
): Promise<Candidate[]> {
	const clay = await clayRoster(ctx, progress);
	const rows: DedupeRow[] = (clay?.rows ?? []).map((row) => ({
		...row,
		source: "clay",
	}));
	let fallback: DedupeRow[] | null = null;
	if (!clay || clay.rejected || clay.capped || dedupe(rows).length === 0) {
		try {
			fallback = await fallbackRoster(ctx, progress);
			rows.push(...fallback);
		} catch (error) {
			progress.capped = true;
			await recordPeopleEvidence(ctx, progress, "fallback-error", {
				message: String(error),
			});
		}
	}
	const candidates = dedupe(rows);
	await recordPeopleEvidence(ctx, progress, "roster", {
		clay: clay
			? {
					rows: clay.rows.length,
					rejected: clay.rejected,
					capped: clay.capped,
					error: clay.error ?? null,
				}
			: null,
		fallback: fallback ? { rows: fallback.length } : null,
		candidates,
		capped: progress.capped,
		clayRecords: progress.clayRecords,
	});
	return candidates;
}
