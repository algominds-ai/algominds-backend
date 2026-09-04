import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { generateStructured, reasoningModel } from "@/core/model";
import { CLAY_BANDS } from "@/core/providers/clay";
import type { Requirement } from "@/core/requirements";
import {
	hardPageRequirements,
	provingWindowDays,
	RequirementSchema,
} from "@/core/requirements";

export const SEARCH_SOURCES = ["exa-search", "exa-agent"] as const;
export const AGENT_EFFORTS = ["low", "medium"] as const;
export const ROUND_ROUTES = ["search", "agent"] as const;

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
	requirements: z.array(RequirementSchema).nullish(),
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
	pageQuery: string | null;
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

const RoundSchema = z.object({
	angle: z.string(),
	query: z.string(),
	pageQuery: z.string().nullable(),
});

const SearchPlanModelSchema = z.object({
	route: z.enum(ROUND_ROUTES).nullable(),
	rounds: z.array(RoundSchema),
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

/** One round's route and the angles it runs, each angle a plan of its own. */
export type SynthesizeResult = {
	route: (typeof ROUND_ROUTES)[number];
	plans: SearchPlan[];
	ledger: CostLedger;
};

const SYNTHESIZE_INSTRUCTIONS = [
	"You turn a list of requirements into one round of company discovery, choosing how the",
	"round runs and writing the angles it runs on.",
	"`route` is `search` or `agent`. A `search` round asks Exa's company index, which",
	"enumerates organisations by their record — headcount, country, founded year, revenue,",
	"industry — a hundred at a time in under a second, and cannot see anything a page says,",
	"so every requirement marked `page` is then proved by one cheap page lookup per",
	"candidate, and only companies that publish such a page survive. An `agent` round reads",
	"the open web, so it finds the population through those pages themselves and returns",
	"few companies per angle. Choose `search` when the requirements marked `record` already",
	"name the population. Choose `agent` when a requirement marked `page` is what defines",
	"who belongs, so no description of a record could enumerate them, or when the previous",
	"round's proven rate shows a search round could not prove that requirement.",
	"Write one entry in `rounds` for each angle asked for. An `angle` names a slice of the",
	"market, for example a vertical, a buyer or a product shape, and each entry carries its",
	"own `query`: one descriptive sentence of fifteen to twenty-five words covering the hard",
	"requirements a company record settles, because Exa matches a query by how a person",
	"would describe the company in a sentence rather than by keywords. The code appends the",
	"numeric bounds and countries afterwards as their own sentences. Every angle must be",
	"genuinely different from the others and from any angle already searched, and every",
	"requirement stays true of all of them.",
	"When a requirement is marked `page`, each entry also carries `pageQuery`: one sentence",
	"describing that proving page itself, as its own author would title it, so a search of",
	"the open web returns pages of that kind. It is null when no requirement is marked",
	"`page`.",
	"Put the profile's bounds in the filter fields: `minWorkforce` and `maxWorkforce` for",
	"headcount, `minFoundedYear` and `maxFoundedYear`, `minRevenueAnnual` and",
	"`maxRevenueAnnual` and `minFundingTotal` and `maxFundingTotal` in whole US dollars,",
	"`countries` as full country names written as Exa writes them, for example United",
	"States, and `userLocation` as the matching two-letter country code.",
	"Set a bound only when a requirement states it; every other bound is null, because a",
	"limit nobody asked for refuses companies that fit.",
	"Each reject reason from the previous round is a correction to make: write the next",
	"angles so the same reason cannot apply again.",
].join(" ");

function requirementBlock(requirements: readonly Requirement[]): string[] {
	return requirements.map(
		(req) => `${req.id} [${req.kind}/${req.proof}] ${req.text}`,
	);
}

function synthesizePrompt(input: SynthesizeInput): string {
	const { pastAngles, feedback, angles } = input;
	const lines = [
		`Today is ${input.today}.`,
		`Write ${angles} ${angles === 1 ? "angle" : "different angles"}.`,
		"Requirements:",
		...requirementBlock(input.requirements),
	];
	if (input.provenRate !== null) {
		lines.push(
			`The previous round proved its page requirements for ${input.provenRate} of its candidates.`,
		);
	}
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

/** The round a profile falls back to when the model writes nothing usable: the profile's own words, on the route its requirements imply. */
function templatePlans(input: SynthesizeInput): SynthesizeResult {
	return {
		route:
			hardPageRequirements(input.requirements).length > 0 ? "agent" : "search",
		plans: [
			{
				query: input.icp.description,
				angle: "the profile as written",
				pageQuery: hardPageRequirements(input.requirements)[0]?.text ?? null,
				recency: null,
				eventWindowDays: null,
				recencyDays: null,
				source: "exa-search",
				agentEffort: "low",
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
			},
		],
		ledger: new CostLedger(),
	};
}

export type SynthesizeInput = {
	icp: IcpDoc;
	requirements: readonly Requirement[];
	pastAngles: readonly string[];
	feedback: readonly string[];
	today: string;
	angles: number;
	provenRate: string | null;
};

type SearchPlanModel = z.infer<typeof SearchPlanModelSchema>;

/** A two-letter country code the vendor accepts, or null for anything else the model wrote. */
function countryCode(value: string | null | undefined): string | null {
	return value && value.length === 2 ? value.toUpperCase() : null;
}

type PlanBounds = Omit<SearchPlan, "query" | "angle" | "pageQuery">;

/** Every limit the profile put on the records a round keeps, plus the evidence demand the requirements imply. An absent limit is null, never zero. */
type EvidenceDemand = Pick<
	SearchPlan,
	"recency" | "eventWindowDays" | "recencyDays" | "source"
>;

/** What a round demands of the agent: the hard page requirement it must prove and the window it must prove it inside. A search round demands nothing, because it proves its own candidates instead. */
function evidenceDemand(
	requirements: readonly Requirement[],
	route: (typeof ROUND_ROUTES)[number],
): EvidenceDemand {
	if (route !== "agent") {
		return {
			recency: null,
			eventWindowDays: null,
			recencyDays: null,
			source: "exa-search",
		};
	}
	const window = provingWindowDays(requirements);
	return {
		recency: hardPageRequirements(requirements)[0]?.text ?? null,
		eventWindowDays: window,
		recencyDays: window,
		source: "exa-agent",
	};
}

function toBounds(
	output: SearchPlanModel,
	requirements: readonly Requirement[],
	route: (typeof ROUND_ROUTES)[number],
): PlanBounds {
	return {
		...evidenceDemand(requirements, route),
		agentEffort: "low",
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

/**
 * The route the round runs on. The model's own choice stands unless the
 * requirements make it impossible: with no requirement that only a page can
 * settle there is nothing for an agent round to demand, so such a round is a
 * plain search whatever the model said.
 */
export function routeFor(
	chosen: (typeof ROUND_ROUTES)[number] | null,
	requirements: readonly Requirement[],
): (typeof ROUND_ROUTES)[number] {
	if (hardPageRequirements(requirements).length === 0) return "search";
	return chosen ?? "agent";
}

/**
 * Turns the profile's requirements, the angles already tried, and the previous
 * round's reject reasons into one route and its angles, each with the numeric
 * limits applied to the records that come back. Falls back to the profile text
 * when the model produces nothing usable twice in a row.
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
	if (!output || output.rounds.length === 0) {
		return { ...templatePlans(input), ledger };
	}
	const route = routeFor(output.route, input.requirements);
	const bounds = toBounds(output, input.requirements, route);
	return {
		route,
		plans: output.rounds.map((round) => ({
			query: round.query,
			angle: round.angle,
			pageQuery: round.pageQuery,
			...bounds,
		})),
		ledger,
	};
}
