import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { generateStructured, reasoningModel } from "@/core/model";

export const REQUIREMENT_KINDS = ["hard", "soft"] as const;
export const REQUIREMENT_PROOFS = ["record", "page"] as const;

export const RequirementSchema = z.object({
	id: z.string(),
	text: z.string(),
	kind: z.enum(REQUIREMENT_KINDS),
	proof: z.enum(REQUIREMENT_PROOFS),
	windowDays: z.number().int().positive().nullable(),
});

export type Requirement = z.infer<typeof RequirementSchema>;

/**
 * What the reader is told when a profile arrives without requirements. The
 * onboarding call writes them from the note and the pages; this wording reads
 * them back out of a description that has already been flattened, so it is the
 * weaker of the two and exists only to backfill.
 */
export const REQUIREMENTS_INSTRUCTIONS = [
	"You read an ideal customer profile and list the requirements a company must satisfy to",
	"fit it. One requirement per idea, each one sentence stating the test a company passes,",
	"never a restatement of the whole profile. Give each an id like r1, r2.",
	"`kind` is `hard` when the profile uses it to say who its customers are, or says it",
	"establishes fit, so a company failing it is out; `soft` when the profile offers it as a",
	"reason to call now or as a preference, so it only orders companies. Where the profile",
	"lists it says nothing about which it is; read what the sentence claims.",
	"`proof` is `page` only when the requirement is what defines the population: no",
	"description of lasting shape — industry, size, place, book of business — could name",
	"these companies, and only a public page tells one in from one out, such as a technology",
	"running in production, a certification, or a dated event.",
	"Everything else is `record`, including a behaviour no record states outright, because",
	"the shape already names the population and the judge settles the fact from the",
	"company's own record and description. A test settled only by finding nothing is",
	"`record`, never `page`.",
	"`windowDays` is how many days old the page proving it may be and still show the",
	"situation is live, or null when age cannot make it stale.",
	"The categories the profile excludes belong in one hard requirement written as the test",
	"a company passes, not one requirement each. Write at most twelve requirements, and",
	"leave room for every reason the profile gives to call a company now.",
].join(" ");

const RequirementsModelSchema = z.object({
	requirements: z.array(RequirementSchema),
});

export type RequirementsResult = {
	requirements: Requirement[];
	ledger: CostLedger;
};

/**
 * Reads the requirements a company must satisfy out of a profile description,
 * for a profile stored before onboarding wrote them. Resolves an empty list
 * when the model produces nothing usable twice, which leaves the round on the
 * search route rather than failing it.
 */
export async function readRequirements(
	description: string,
	env: Env,
): Promise<RequirementsResult> {
	const ledger = new CostLedger();
	const output = await generateStructured(
		{
			model: await reasoningModel(env),
			configuredId: env.MODEL_ROUTE_REASONING,
			instructions: REQUIREMENTS_INSTRUCTIONS,
			prompt: `Ideal customer profile:\n${description}`,
			schema: RequirementsModelSchema,
			headers: { "cf-aig-skip-cache": "true" },
		},
		ledger,
		"requirements",
	);
	return { requirements: output?.requirements ?? [], ledger };
}

/** The requirements a company must satisfy and that only a public page can settle: the ones a round has to prove before it stores anything. */
export function hardPageRequirements(
	requirements: readonly Requirement[],
): Requirement[] {
	return requirements.filter(
		(req) => req.kind === "hard" && req.proof === "page",
	);
}

export function hardRequirements(
	requirements: readonly Requirement[],
): Requirement[] {
	return requirements.filter((req) => req.kind === "hard");
}

/** The shortest window any hard page requirement names, or null when none of them bounds a page's age. */
export function provingWindowDays(
	requirements: readonly Requirement[],
): number | null {
	const windows = hardPageRequirements(requirements)
		.map((req) => req.windowDays)
		.filter((days): days is number => days !== null);
	return windows.length > 0 ? Math.min(...windows) : null;
}

/** One requirement's line for a model prompt: the id the reply must use, then the test. */
export function requirementLine(req: Requirement): string {
	return `${req.id} ${req.text}`;
}
