import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { generateStructured, reasoningModel } from "@/core/model";
import { CLAY_BANDS } from "@/core/providers/clay";

export const SEARCH_SOURCES = ["exa-search", "exa-agent"] as const;
export const AGENT_EFFORTS = ["low", "medium"] as const;

/** The eight most senior bands, the default a buyer rubric searches with. */
export const SENIOR_BANDS: readonly (typeof CLAY_BANDS)[number][] =
	CLAY_BANDS.slice(0, 8);

export const BandSchema = z.enum(CLAY_BANDS);

export const IcpBuyerSchema = z.object({
	rubric: z.string(),
	bands: z.array(BandSchema),
	keywordBands: z.array(
		z.object({
			band: BandSchema,
			keywords: z.array(z.string()),
		}),
	),
});

export type IcpBuyer = z.infer<typeof IcpBuyerSchema>;

export const IcpDocSchema = z.object({
	description: z.string(),
	seller: z
		.object({
			domain: z.string(),
			customers: z.array(z.string()),
			competitorTest: z.string(),
		})
		.nullish(),
	buyer: IcpBuyerSchema.nullish(),
});

export type IcpDoc = z.infer<typeof IcpDocSchema>;

export type IcpSeller = NonNullable<IcpDoc["seller"]>;

/**
 * One round's Exa request plus the constraints applied to the returned
 * company records. `query` and `userLocation` go to Exa; the rest filter the
 * structured entity Exa returns. See `docs/solutions/exa-search-contract.md`.
 */
export type SearchPlan = {
	query: string;
	angle: string;
	recency: string | null;
	eventWindowDays: number | null;
	recencyDays: number | null;
	source: (typeof SEARCH_SOURCES)[number];
	agentEffort: (typeof AGENT_EFFORTS)[number];
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
	recency: z.string().nullable(),
	eventWindowDays: z.number().int().positive().nullable(),
	recencyDays: z.number().int().positive().nullable(),
	source: z.enum(SEARCH_SOURCES).nullable(),
	agentEffort: z.enum(AGENT_EFFORTS).nullable(),
	userLocation: z.string().nullable(),
	countries: z.array(z.string()),
	minWorkforce: z.number().nullable(),
	maxWorkforce: z.number().nullable(),
	minFoundedYear: z.number().nullable(),
	maxFoundedYear: z.number().nullable(),
	minRevenueAnnual: z.number().nullable(),
	maxRevenueAnnual: z.number().nullable(),
	minFundingTotal: z.number().nullable(),
	maxFundingTotal: z.number().nullable(),
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
	"`source` is `exa-search` unless the event is the whole qualifier. `exa-search` reads",
	"Exa's company index: a hundred structured company records in one second, no pages and",
	"no dates. `exa-agent` reads the open web for the signal and the page proving it, at a",
	"handful of companies in minutes. A profile that says what its companies are — industry,",
	"size, place, book of business — and then adds recent events as reasons to call now is a",
	"search round: the shape names the population and the events only order it. Choose",
	"`exa-agent` only when no description of lasting shape could name this population and",
	"only a page can tell a company in from one out.",
	"`agentEffort` applies to `exa-agent` only: `low` for a population it can name without",
	"digging, `medium` when the signal needs dated proof. Null means `medium`.",
	"`recency`, `eventWindowDays` and `recencyDays` belong to an `exa-agent` round and are",
	"all null on a search round, because the company index holds no pages and no dates.",
	"On an agent round, `recency` names each event and the window it must fall inside,",
	"written as spans counted back from today. `eventWindowDays` is how far back the event",
	"itself may have happened. `recencyDays` answers a different question for the angle this",
	"round targets: how old may the page proving it be and still show the situation is live",
	"today? An announcement from January does not show January's work is still going on; a",
	"page published this month describing it does. So `eventWindowDays` may be a year while",
	"`recencyDays` is a few weeks. The code refuses a dated page older than `recencyDays`",
	"and sends an undated one to the judge.",
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
		lines.push("What the previous round did, and why it refused things:");
		for (const reason of feedback) lines.push(`- ${reason}`);
	}
	return lines.join("\n");
}

function templatePlan(icp: IcpDoc): SearchPlan {
	return {
		query: icp.description,
		angle: "the profile as written",
		recency: null,
		eventWindowDays: null,
		recencyDays: null,
		source: "exa-search",
		agentEffort: "medium",
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

type SearchPlanModel = z.infer<typeof SearchPlanModelSchema>;

/** A two-letter country code the vendor accepts, or null for anything else the model wrote. */
function countryCode(value: string | null | undefined): string | null {
	return value && value.length === 2 ? value.toUpperCase() : null;
}

type PlanBounds = Pick<
	SearchPlan,
	| "userLocation"
	| "countries"
	| "minWorkforce"
	| "maxWorkforce"
	| "minFoundedYear"
	| "maxFoundedYear"
	| "minRevenueAnnual"
	| "maxRevenueAnnual"
	| "minFundingTotal"
	| "maxFundingTotal"
>;

/** Every limit the profile put on the records a round keeps. An absent limit is null, never zero. */
function toBounds(output: SearchPlanModel): PlanBounds {
	return {
		userLocation: countryCode(output.userLocation),
		countries: output.countries,
		minWorkforce: output.minWorkforce,
		maxWorkforce: output.maxWorkforce,
		minFoundedYear: output.minFoundedYear ?? null,
		maxFoundedYear: output.maxFoundedYear ?? null,
		minRevenueAnnual: output.minRevenueAnnual ?? null,
		maxRevenueAnnual: output.maxRevenueAnnual ?? null,
		minFundingTotal: output.minFundingTotal ?? null,
		maxFundingTotal: output.maxFundingTotal ?? null,
	};
}

function toPlan(output: SearchPlanModel): SearchPlan {
	return {
		query: output.query,
		angle: output.angle,
		recency: output.recency ?? null,
		eventWindowDays: output.eventWindowDays ?? null,
		recencyDays: output.recencyDays ?? null,
		source: output.source ?? "exa-search",
		agentEffort: output.agentEffort ?? "medium",
		...toBounds(output),
	};
}

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
			model: await reasoningModel(env),
			configuredId: env.MODEL_ROUTE_REASONING,
			instructions: SYNTHESIZE_INSTRUCTIONS,
			prompt: synthesizePrompt(input),
			schema: SearchPlanModelSchema,
			headers: { "cf-aig-skip-cache": "true" },
		},
		ledger,
		"synthesize",
	);
	if (!output) return { plan: templatePlan(input.icp), ledger };
	return { plan: toPlan(output), ledger };
}
