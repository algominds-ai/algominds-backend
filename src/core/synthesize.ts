import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { generateStructured, workerModel } from "@/core/model";

export const IcpDocSchema = z.object({
	description: z.string(),
});

export type IcpDoc = z.infer<typeof IcpDocSchema>;

/**
 * One round's Exa request plus the constraints applied to the returned
 * company records. `query` and `userLocation` go to Exa; the rest filter the
 * structured entity Exa returns. See `docs/solutions/exa-search-contract.md`.
 */
export type SearchPlan = {
	query: string;
	angle: string;
	userLocation: string | null;
	countries: string[];
	minWorkforce: number | null;
	maxWorkforce: number | null;
	minFoundedYear: number | null;
	maxFoundedYear: number | null;
	minRevenueAnnual: number | null;
	maxRevenueAnnual: number | null;
	minFundingTotal: number | null;
	maxFundingTotal: number | null;
};

const SearchPlanModelSchema = z.object({
	query: z.string(),
	angle: z.string(),
	userLocation: z.string().nullable(),
	countries: z.array(z.string()),
	minWorkforce: z.number().nullable(),
	maxWorkforce: z.number().nullable(),
	minFoundedYear: z.number().nullish(),
	maxFoundedYear: z.number().nullish(),
	minRevenueAnnual: z.number().nullish(),
	maxRevenueAnnual: z.number().nullish(),
	minFundingTotal: z.number().nullish(),
	maxFundingTotal: z.number().nullish(),
});

export type SynthesizeResult = {
	plan: SearchPlan;
	ledger: CostLedger;
};

const SYNTHESIZE_INSTRUCTIONS = [
	"You turn an ideal customer profile into one round of company discovery against Exa's",
	"company index. Exa matches a query by how a person would describe the company in a",
	"sentence, not by keywords. Write `query` as one short descriptive sentence of about",
	"fifteen to twenty-five words. Put no numbers, no revenue band, and no headcount in it.",
	"Exa returns a structured record for each company, so numeric limits belong in the filter",
	"fields instead: set `minWorkforce` and `maxWorkforce` to the headcount range the profile",
	"asks for, `minFoundedYear` and `maxFoundedYear` to the years it was founded between,",
	"`minRevenueAnnual` and `maxRevenueAnnual` to the annual revenue in whole US dollars,",
	"`minFundingTotal` and `maxFundingTotal` to the funding raised in whole US dollars,",
	"`countries` to the full country names the profile allows, written as Exa writes",
	"them, for example United States, and `userLocation` to the matching two-letter country",
	"code, or null when the profile names no country.",
	"Set a bound only when the profile asks for it. Every bound the profile does not name is",
	"null, because a limit nobody asked for refuses companies that fit.",
	"`angle` names the slice of the market this round targets, for example the vertical, the",
	"buyer, or the product shape.",
	"A paraphrase of an earlier query returns the same companies, so when earlier angles are",
	"given, choose a genuinely different angle and write a query for it. Keep every constraint",
	"of the profile true of that new angle.",
].join(" ");

function synthesizePrompt(
	icp: IcpDoc,
	pastAngles: readonly string[],
	feedback: readonly string[],
): string {
	const lines = ["Ideal customer profile:", icp.description];
	if (pastAngles.length > 0) {
		lines.push("Angles already searched, do not repeat them:");
		for (const angle of pastAngles) lines.push(`- ${angle}`);
	}
	if (feedback.length > 0) {
		lines.push("Reasons the previous round's companies were rejected:");
		for (const reason of feedback) lines.push(`- ${reason}`);
	}
	return lines.join("\n");
}

function templatePlan(icp: IcpDoc): SearchPlan {
	return {
		query: icp.description,
		angle: "the profile as written",
		userLocation: null,
		countries: [],
		minWorkforce: null,
		maxWorkforce: null,
		minFoundedYear: null,
		maxFoundedYear: null,
		minRevenueAnnual: null,
		maxRevenueAnnual: null,
		minFundingTotal: null,
		maxFundingTotal: null,
	};
}

export type SynthesizeInput = {
	icp: IcpDoc;
	pastAngles: readonly string[];
	feedback: readonly string[];
};

/**
 * Turns an ideal customer profile, the angles already tried, and the previous
 * round's reject reasons into one Exa query plus the numeric limits applied to
 * the returned records. Falls back to the profile text when the model produces
 * nothing usable twice in a row.
 */
export async function synthesize(
	input: SynthesizeInput,
	env: Env,
): Promise<SynthesizeResult> {
	const ledger = new CostLedger();
	const output = await generateStructured(
		{
			model: await workerModel(env),
			configuredId: env.MODEL_ROUTE_WORKER,
			instructions: SYNTHESIZE_INSTRUCTIONS,
			prompt: synthesizePrompt(input.icp, input.pastAngles, input.feedback),
			schema: SearchPlanModelSchema,
			headers: { "cf-aig-skip-cache": "true" },
		},
		ledger,
		"synthesize",
	);
	if (!output) return { plan: templatePlan(input.icp), ledger };
	return {
		plan: {
			query: output.query,
			angle: output.angle,
			userLocation:
				output.userLocation && output.userLocation.length === 2
					? output.userLocation.toUpperCase()
					: null,
			countries: output.countries,
			minWorkforce: output.minWorkforce,
			maxWorkforce: output.maxWorkforce,
			minFoundedYear: output.minFoundedYear ?? null,
			maxFoundedYear: output.maxFoundedYear ?? null,
			minRevenueAnnual: output.minRevenueAnnual ?? null,
			maxRevenueAnnual: output.maxRevenueAnnual ?? null,
			minFundingTotal: output.minFundingTotal ?? null,
			maxFundingTotal: output.maxFundingTotal ?? null,
		},
		ledger,
	};
}
