import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { generateStructured, reasoningModel } from "@/core/model";

export const SEARCH_SOURCES = ["exa-search", "exa-agent"] as const;
/** `deep-lite` is absent on purpose: measured against `category: "company"` it returns pages with no company record, so every row falls at the filter. */
export const SEARCH_TYPES = ["fast", "deep", "deep-reasoning"] as const;
export const AGENT_EFFORTS = ["minimal", "low", "medium", "high"] as const;

const DEEP_TYPES: ReadonlySet<string> = new Set(["deep", "deep-reasoning"]);

/** True when a search type runs the multi-step planner that `additionalQueries` feeds. */
export function acceptsAdditionalQueries(type: string): boolean {
	return DEEP_TYPES.has(type);
}

/** Clay's closed set of fourteen seniority bands, in Clay's own order. */
export const CLAY_BANDS = [
	"founder",
	"owner",
	"board-member",
	"partner",
	"c-suite",
	"vp",
	"director",
	"head",
	"manager",
	"senior",
	"mid-level",
	"entry",
	"intern",
	"unknown",
] as const;

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
	type: (typeof SEARCH_TYPES)[number];
	agentEffort: (typeof AGENT_EFFORTS)[number];
	additionalQueries: string[];
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
	type: z.enum(SEARCH_TYPES).nullable(),
	agentEffort: z.enum(AGENT_EFFORTS).nullable(),
	additionalQueries: z.array(z.string()).nullable(),
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
	"`source` chooses where the round buys its candidates. `exa-search` is one call against",
	"Exa's company index: a structured record for every company, carrying headcount,",
	"country, revenue and funding, about a hundred of them in a second or two for a tenth",
	"of the price. It holds no pages, no events and no dates. `exa-agent` searches the open",
	"web and reads what it finds: the signal, the page that proves it, and the date printed",
	"on that page. It takes minutes and costs far more. Choose the one that can answer the",
	"round you are writing.",
	"`type` chooses how hard the search itself works, and applies to `exa-search` only.",
	"Measured on one profile asking for twenty five records: `fast` returned twenty five in",
	"half a second, `deep` returned fifteen in four seconds, and `deep-reasoning` returned",
	"twenty five in fourteen seconds and reached a different set of companies. Only `deep`",
	"and `deep-reasoning` read `additionalQueries`. Choose `fast` unless the profile hides",
	"several distinct kinds of company that one sentence cannot describe together, and then",
	"choose `deep` and write the variations.",
	"`additionalQueries` are extra query sentences the deep types run beside the main one.",
	"Write one for each distinct direction the profile allows, for example a different",
	"vertical or a different job the product does. Measured: three variations took one deep",
	"search from fifteen records to twenty five, and twenty two of those twenty five",
	"companies were ones the same search without variations never found. Leave the list",
	"empty on `fast`, where the vendor accepts the field and ignores it.",
	"`agentEffort` is how long `exa-agent` may work, and applies to `exa-agent` only.",
	"Choose `medium`. Measured on the same profile and the same count, `medium` returned",
	"evidence with a median age of thirty two days against `low`'s fifty three, both fully",
	"inside the window the profile asked for, at indistinguishable cost. Raise it above",
	"`medium` only when an earlier round on this run came back short of the count.",
	"`eventWindowDays` is how far back the profile allows the event itself to have happened,",
	"counted in days. `recencyDays` answers a different question: how old may the page",
	"proving it be, and still show that this situation is live and worth acting on today?",
	"Answer it for the angle this round targets, not for the profile as a whole.",
	"A page that proves a situation is still live is almost always days or weeks old, not",
	"months. An announcement from January does not show that January's event is still being",
	"worked on today; a page published this month describing that work does. Ask what page",
	"you would want to read before making the call today, and how old it could be before you",
	"would stop trusting it. `eventWindowDays` may be a year while `recencyDays` is a few",
	"weeks, and that is the normal case rather than a contradiction. The code refuses a page",
	"older than `recencyDays`. A page carrying no date still reaches the judge, which decides",
	"whether it proves the signal anyway, so a window costs you nothing in undated pages.",
	"Leave both null only when `recency` is null.",
	"`recency` carries the freshness the profile demands, written as its own sentences that",
	"name each event and the window it must fall inside, for example a platform engineering",
	"role posted in the last thirty days, or a postmortem published in the last ninety days.",
	"Write every window as a span counted back from today, never as a fixed date.",
	"A profile that lists events against windows — a licence announced in the last twelve",
	"months, a funding round closed in the last hundred and twenty days, a role posted in",
	"the last six — is asking for something recent, and those events are what `recency` is",
	"for. Carry them into it. Leaving `recency` null there discards the whole reason a",
	"company is worth reaching now, and sends the round to a source that holds no events.",
	"Set `recency` to null only when the profile names no event at all, because a freshness",
	"demand nobody made refuses companies that fit.",
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
	"That report also says what the round's freshness demand bought: the window it asked",
	"for, and how old the pages it kept really were. Pages far fresher than the window",
	"allowed mean this market publishes faster than you assumed, so ask for less. A round",
	"that kept nothing means evidence that fresh is scarce here, so ask for more.",
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
		type: "fast",
		agentEffort: "medium",
		additionalQueries: [],
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
	const type = output.type ?? "fast";
	return {
		query: output.query,
		angle: output.angle,
		recency: output.recency ?? null,
		eventWindowDays: output.eventWindowDays ?? null,
		recencyDays: output.recencyDays ?? null,
		source: output.source ?? "exa-search",
		type,
		agentEffort: output.agentEffort ?? "medium",
		additionalQueries: acceptsAdditionalQueries(type)
			? (output.additionalQueries ?? [])
			: [],
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
