import { z } from "zod";
import { CostLedger } from "@/core/cost";
import type { IcpDoc, Requirement } from "@/core/icp";
import { generateStructured, reasoningModel } from "@/core/model";
import { evidenceDemandConditions } from "@/core/requirements";

export type { IcpDoc, IcpSeller, Requirement } from "@/core/icp";
export { IcpDocSchema } from "@/core/icp";

export const SEARCH_SOURCES = ["exa-search", "exa-agent"] as const;
export const AGENT_EFFORTS = ["minimal", "low", "medium"] as const;
export const ROUND_ROUTES = ["search", "agent"] as const;

/**
 * One round's Exa request plus the constraints applied to the returned
 * company records. `query` and `userLocation` go to Exa; the rest filter the
 * structured entity Exa returns. See `docs/solutions/exa-search-contract.md`.
 */
export type SearchPlan = {
	query: string;
	angle: string;
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
	"Company search returns name, description, founded year, headcount, headquarters and financials. Use search when these record fields can establish the mandatory criteria; it returns up to 100 candidates cheaply.",
	"Use agent when a mandatory predicate needs evidence beyond these record fields, including undated technical or operating conditions,",
	"or when earlier search candidates repeatedly lacked the necessary evidence. Start with focused queries; revise the angle from concrete misses.",
	"Use one search angle for breadth, or up to the requested number of distinct agent angles exploring different qualifying alternatives within required groups, company segments, or evidence sources. Search queries describe the company population concisely;",
	"agent queries describe the research task and missing proof. The agent also receives the scoped seller context and grouped company requirements.",
	"The code appends numeric bounds and countries to search queries. Every angle must preserve all mandatory criteria.",
	"Put the profile's bounds in the filter fields: `minWorkforce` and `maxWorkforce` for",
	"headcount, `minFoundedYear` and `maxFoundedYear`, `minRevenueAnnual` and",
	"`maxRevenueAnnual` and `minFundingTotal` and `maxFundingTotal` in whole US dollars,",
	"`countries` as full country names written as Exa writes them, for example United",
	"States, and `userLocation` as the matching two-letter country code.",
	"Provider filters are ANDed. Set a bound only if every qualifying alternative must satisfy it.",
	"Never put a preferred bound or one branch of an OR into a global filter. Leave it null and retain the condition in the query and judge.",
	"Do not expand a region into a guessed partial country list. Leave countries empty for regional intent and let qualification check it. Countries filter headquarters only: service markets and buyer locations must not set countries or userLocation.",
	"Preserve required groups as AND, alternatives as OR and each alternative's conditions as AND. Preferences never exclude otherwise eligible companies.",
	"Each reject reason from the previous round is a correction to make: write the next",
	"angles so the same reason cannot apply again.",
].join(" ");

function profileDescription(input: SynthesizeInput): string {
	return [
		input.icp.seller.description,
		input.icp.icp.offer,
		JSON.stringify(input.requirements),
	]
		.filter((value): value is string => value !== null && value.trim() !== "")
		.join(" ");
}

function synthesizePrompt(input: SynthesizeInput): string {
	const { pastAngles, feedback, angles } = input;
	const lines = [
		`Today is ${input.today}.`,
		`Write one search angle, or up to ${angles} different agent angles.`,
		`Seller: ${input.icp.seller.description}`,
		`Offer in scope: ${input.icp.icp.offer ?? ""}`,
		"Company requirements:",
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
 * profile's own words, preserving its grouped requirements and date windows.
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
				query: profileDescription(input),
				angle: "the profile as written",
				source: route === "agent" ? "exa-agent" : "exa-search",
				agentEffort: "minimal",
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

function toBounds(
	output: SearchPlanModel,
	route: (typeof ROUND_ROUTES)[number],
): PlanBounds {
	return {
		source: route === "agent" ? "exa-agent" : "exa-search",
		agentEffort: "minimal",
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
			reasoningEffort: "low",
			headers: { "cf-aig-skip-cache": "true" },
		},
		ledger,
		"synthesize",
	);
	if (!output || output.rounds.length === 0) {
		return { ...templatePlans(input), ledger };
	}
	const route = output.route ?? "search";
	const bounds = toBounds(output, route);
	return {
		route,
		plans: output.rounds
			.slice(0, route === "search" ? 1 : input.angles)
			.map((round) => ({
				query: round.query,
				angle: round.angle,
				...bounds,
			})),
		ledger,
	};
}
