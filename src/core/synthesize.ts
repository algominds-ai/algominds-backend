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
	recency: string | null;
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
	recency: z.string().nullish(),
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
	"fifteen to twenty-five words. Write only the descriptive sentence there; the code adds",
	"the profile's numeric bounds and countries to it afterward, as its own sentences.",
	"Exa returns a structured record for each company, so numeric limits also belong in the",
	"filter fields: set `minWorkforce` and `maxWorkforce` to the headcount range the profile",
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
	"`recency` carries the freshness the profile demands, written as its own sentences that",
	"name each event and the window it must fall inside, for example a platform engineering",
	"role posted in the last thirty days, or a postmortem published in the last ninety days.",
	"Write every window as a span counted back from today, never as a fixed date. Set",
	"`recency` to null when the profile asks for nothing recent, because a freshness demand",
	"nobody made refuses companies that fit.",
	"A paraphrase of an earlier query returns the same companies, so when earlier angles are",
	"given, choose a genuinely different angle and write a query for it. Keep every constraint",
	"of the profile true of that new angle.",
	"The reasons an earlier round's companies were refused say what that round's query got",
	"wrong, and each one is a correction to make. Companies refused for being too small mean",
	"the query described a smaller organisation than the profile wants, so describe the scale",
	"the profile asks for in words: what such a company operates, who it serves, what it is",
	"accountable for. Companies refused for their country mean the query read as belonging",
	"somewhere else. Companies refused as not being a company at all mean the query read like",
	"a topic rather than an organisation. Write the next query so the same reason cannot",
	"apply again.",
].join(" ");

function synthesizePrompt(input: SynthesizeInput): string {
	const { icp, pastAngles, feedback } = input;
	const lines = [
		`Today is ${input.today}.`,
		"Ideal customer profile:",
		icp.description,
	];
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
		recency: null,
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
	today: string;
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
			prompt: synthesizePrompt(input),
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
			recency: output.recency ?? null,
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
