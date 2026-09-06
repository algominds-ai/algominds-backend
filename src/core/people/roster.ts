import { z } from "zod";
import { addPartialSpend, type CostLedger } from "@/core/cost";
import { generateStructured, workerModel } from "@/core/model";
import type { ResolvedBuyer } from "@/core/people/buyer";
import type { Candidate } from "@/core/people/candidate";
import type { DedupeRow } from "@/core/people/dedupe";
import { dedupe } from "@/core/people/dedupe";
import { CLAY_BANDS, claySearch } from "@/core/providers/clay";

export type SeniorRosterResult = {
	candidates: Candidate[];
	raw: string[];
	quotaUsed: number;
};

const ProviderHintsSchema = z.object({
	bands: z.array(z.enum(CLAY_BANDS)),
	keywords: z.array(z.string().min(1)),
});

export type PeopleProviderHints = z.infer<typeof ProviderHintsSchema>;

export const EMPTY_PROVIDER_HINTS: PeopleProviderHints = {
	bands: [],
	keywords: [],
};

const PROVIDER_HINT_INSTRUCTIONS = [
	"Derive only ephemeral people-search hints from the supplied buyer data.",
	"Select seniority bands or exact role keywords only when the buyer text supports them.",
	"Do not infer a default seniority, geography, company size, or buyer responsibility.",
	"An empty list is valid. Return only the closed schema fields.",
].join(" ");

type RosterSlice = {
	bands?: readonly [
		(typeof CLAY_BANDS)[number],
		...(typeof CLAY_BANDS)[number][],
	];
	keywords?: string[];
	source: string;
};

function rosterSlices(hints: PeopleProviderHints): RosterSlice[] {
	return [
		...hints.bands.map(
			(band): RosterSlice => ({
				bands: [band],
				source: `clay:${band}`,
			}),
		),
		...(hints.keywords.length > 0
			? [{ keywords: hints.keywords, source: "clay:keywords" }]
			: []),
	];
}

async function collectRosterResults(
	identifier: string,
	slices: readonly RosterSlice[],
	env: Env,
	ledger: CostLedger,
): Promise<{ rows: DedupeRow[]; raw: string[]; quotaUsed: number }> {
	const rows: DedupeRow[] = [];
	const raw: string[] = [];
	let quotaUsed = 0;
	for (const slice of slices) {
		const result = await claySearch(
			env,
			{
				identifier,
				...(slice.bands ? { bands: [...slice.bands] } : {}),
				...(slice.keywords ? { keywords: slice.keywords } : {}),
			},
			ledger,
		);
		raw.push(...result.raw);
		quotaUsed += result.quotaUsed;
		for (const row of result.rows) rows.push({ ...row, source: slice.source });
	}
	return { rows, raw, quotaUsed };
}

/** Derives provider filters at people-run time; the result is never persisted in the ICP. */
export async function deriveProviderHints(
	buyer: ResolvedBuyer,
	env: Env,
	ledger: CostLedger,
): Promise<PeopleProviderHints> {
	if (buyer.rubric === null) return EMPTY_PROVIDER_HINTS;
	try {
		const reply = await generateStructured(
			{
				model: await workerModel(env),
				configuredId: env.MODEL_ROUTE_WORKER,
				instructions: PROVIDER_HINT_INSTRUCTIONS,
				prompt: [
					"<offer>",
					buyer.offer ?? "",
					"</offer>",
					"<targeting-instructions>",
					buyer.instructions ?? "",
					"</targeting-instructions>",
					"<buyer-responsibility>",
					buyer.rubric,
					"</buyer-responsibility>",
				].join("\n"),
				schema: ProviderHintsSchema,
				headers: {},
			},
			ledger,
			"people-provider-hints",
		);
		return reply ?? EMPTY_PROVIDER_HINTS;
	} catch (error) {
		throw addPartialSpend(error, ledger.total());
	}
}

/**
 * Runs one Clay search per ephemeral band and one keyword slice, then unions
 * and dedupes every row returned. Empty hints intentionally make no Clay call.
 */
export async function seniorRoster(
	identifier: string,
	hints: PeopleProviderHints,
	env: Env,
	ledger: CostLedger,
): Promise<SeniorRosterResult> {
	const slices = rosterSlices(hints);
	const result = await collectRosterResults(identifier, slices, env, ledger);
	return {
		candidates: dedupe(result.rows),
		raw: result.raw,
		quotaUsed: result.quotaUsed,
	};
}
