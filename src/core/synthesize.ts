import { z } from "zod";
import { CostLedger } from "@/core/cost";
import type { IcpDoc, Requirement } from "@/core/icp";
import { generateStructured, reasoningModel } from "@/core/model";
import {
	conditionRefs,
	evidenceDemandConditions,
	requirementLine,
} from "@/core/requirements";

export type { IcpDoc, IcpSeller, Requirement } from "@/core/icp";
export { IcpDocSchema } from "@/core/icp";

export const SEARCH_SOURCES = ["exa-search", "exa-agent"] as const;
export const AGENT_EFFORTS = ["low", "medium"] as const;
export const ROUND_ROUTES = ["search", "agent"] as const;

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
	conditionIds?: string[];
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
	"so every required condition with a date or source rule is then proved by one cheap page lookup per",
	"candidate, and only companies that publish such a page survive. An `agent` round reads",
	"the open web, so it finds the population through those pages themselves and returns",
	"few companies per angle. Choose `search` when the requirements already name the population.",
	"Choose `agent` when a dated or source-bound condition defines who belongs, so no description",
	"of a record could enumerate them, or when the previous",
	"round's proven rate shows a search round could not prove that requirement.",
	"Write one entry in `rounds` for each angle asked for. An `angle` names a slice of the",
	"market, for example a vertical, a buyer or a product shape, and each entry carries its",
	"own `query`: one descriptive sentence of fifteen to twenty-five words covering the hard",
	"requirements a company record settles, because Exa matches a query by how a person",
	"would describe the company in a sentence rather than by keywords. The code appends the",
	"numeric bounds and countries afterwards as their own sentences. Every angle must be",
	"genuinely different from the others and from any angle already searched, and every",
	"requirement stays true of all of them.",
	"Put the profile's bounds in the filter fields: `minWorkforce` and `maxWorkforce` for",
	"headcount, `minFoundedYear` and `maxFoundedYear`, `minRevenueAnnual` and",
	"`maxRevenueAnnual` and `minFundingTotal` and `maxFundingTotal` in whole US dollars,",
	"`countries` as full country names written as Exa writes them, for example United",
	"States, and `userLocation` as the matching two-letter country code.",
	"Provider filters are ANDed. Set a bound only if every qualifying alternative must satisfy it.",
	"Never put a preferred bound or one branch of an OR into a global filter. Leave it null and retain the condition in the query and judge.",
	"Countries filter headquarters only: service markets and buyer locations must not set countries or userLocation.",
	"Preserve required groups as AND, alternatives as OR and each alternative's conditions as AND. Preferences never exclude otherwise eligible companies.",
	"Each reject reason from the previous round is a correction to make: write the next",
	"angles so the same reason cannot apply again.",
].join(" ");

function profileDescription(icp: IcpDoc): string {
	return [
		icp.seller.description,
		icp.icp.offer,
		icp.icp.buyer,
		...conditionRefs(icp.icp.requirements).map((ref) => ref.condition.text),
	]
		.filter((value): value is string => value !== null && value.trim() !== "")
		.join(" ");
}

function synthesizePrompt(input: SynthesizeInput): string {
	const { pastAngles, feedback, angles } = input;
	const lines = [
		`Today is ${input.today}.`,
		`Write ${angles} ${angles === 1 ? "angle" : "different angles"}.`,
		...(input.icp.instructions
			? [
					`The user's exact targeting instructions (authoritative): ${input.icp.instructions}`,
				]
			: []),
		`Profile: ${profileDescription(input.icp)}`,
		...(input.icp.seller.customers.length > 0
			? [
					`Seller customers for context; suppress only when targeting instructions explicitly require it: ${input.icp.seller.customers.join(", ")}`,
				]
			: []),
		"Requirements:",
		JSON.stringify(input.requirements),
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

/**
 * The round a profile falls back to when the model writes nothing usable: the
 * profile's own words, on the route its requirements imply, carrying the same
 * evidence demand a normal agent round would — an agent route with no
 * requirement's own demand attached never sees its cited page checked.
 */
function templatePlans(input: SynthesizeInput): SynthesizeResult {
	const route =
		evidenceDemandConditions(input.requirements).length > 0
			? "agent"
			: "search";
	return {
		route,
		plans: [
			{
				query: profileDescription(input.icp),
				angle: "the profile as written",
				...evidenceDemand(input.requirements, route),
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

type PlanBounds = Omit<SearchPlan, "query" | "angle">;

/** Every limit the profile put on the records a round keeps, plus the evidence demand the requirements imply. An absent limit is null, never zero. */
type EvidenceDemand = Pick<
	SearchPlan,
	"recency" | "eventWindowDays" | "recencyDays" | "source" | "conditionIds"
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
	const demands = evidenceDemandConditions(requirements);
	const windows = demands
		.map((ref) => ref.condition.window)
		.filter((window): window is NonNullable<typeof window> => window !== null);
	const publicationDays = windows
		.filter(
			(window) =>
				window.unit === "days" &&
				window.direction === "past" &&
				window.appliesTo === "publication",
		)
		.map((window) => window.amount);
	const firstPublicationWindow = publicationDays[0] ?? null;
	const commonWindow =
		firstPublicationWindow !== null &&
		publicationDays.every((amount) => amount === firstPublicationWindow)
			? firstPublicationWindow
			: null;
	return {
		recency:
			demands.length > 0
				? demands.map((ref) => requirementLine(ref)).join("; ")
				: null,
		eventWindowDays: commonWindow,
		recencyDays: commonWindow,
		source: "exa-agent",
		conditionIds: demands.map((ref) => ref.id),
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
		minWorkforce: output.minWorkforce ?? null,
		maxWorkforce: output.maxWorkforce ?? null,
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
function routeFor(
	chosen: (typeof ROUND_ROUTES)[number] | null,
	requirements: readonly Requirement[],
): (typeof ROUND_ROUTES)[number] {
	if (evidenceDemandConditions(requirements).length === 0) return "search";
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
			...bounds,
		})),
		ledger,
	};
}
