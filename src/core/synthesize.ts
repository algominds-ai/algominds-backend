import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { generateStructured, workerModel } from "@/core/model";

export const IcpDocSchema = z.object({
	description: z.string(),
});

export type IcpDoc = z.infer<typeof IcpDocSchema>;

/**
 * The decision Exa's `/search` needs. `category` is present only for a
 * broad semantic match on the ICP; it never appears together with
 * `startPublishedDate`, because Exa rejects that combination outright.
 */
export type SearchShape = {
	category?: "company";
	type: "neural" | "keyword";
	startPublishedDate?: string;
};

const DEFAULT_SIGNAL_WINDOW_DAYS = 30;

function isIsoDate(value: string | null): value is string {
	return value !== null && !Number.isNaN(new Date(value).getTime());
}

function defaultSignalDate(): string {
	const windowMs = DEFAULT_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
	return new Date(Date.now() - windowMs).toISOString().slice(0, 10);
}

const SearchShapeModelSchema = z.object({
	category: z.enum(["company", "none"]),
	startPublishedDate: z.string().nullable(),
});

function normalizeSearchShape(
	raw: z.infer<typeof SearchShapeModelSchema>,
): SearchShape {
	if (raw.category === "company")
		return { category: "company", type: "neural" };
	return {
		type: "neural",
		startPublishedDate: isIsoDate(raw.startPublishedDate)
			? raw.startPublishedDate
			: defaultSignalDate(),
	};
}

const SynthesizeModelSchema = z.object({
	query: z.string(),
	systemPrompt: z.string(),
	searchShape: SearchShapeModelSchema,
});

export type SynthesizeResult = {
	query: string;
	systemPrompt: string;
	searchShape: SearchShape;
	ledger: CostLedger;
};

const SYNTHESIZE_INSTRUCTIONS = [
	"You write one search request for a round of company discovery against an ideal customer",
	"profile. Return a query string, a system prompt telling the search step what to extract",
	'from each result, and a search shape. A search shape is either category "company" for a',
	'broad semantic match on the ideal customer profile, or category "none" with a',
	"startPublishedDate for companies showing a recent hiring or funding signal. Keep the query",
	"faithful to every constraint in the profile, including team size, revenue, and which",
	"functions the company does or does not have. When rejection reasons are given, change the",
	"query enough to reach different companies without dropping any stated constraint.",
].join(" ");

function synthesizePrompt(icp: IcpDoc, feedback: readonly string[]): string {
	const lines = [`Ideal customer profile:`, icp.description];
	if (feedback.length > 0) {
		lines.push("Reasons the previous round's companies were rejected:");
		for (const reason of feedback) lines.push(`- ${reason}`);
	}
	return lines.join("\n");
}

function templateResult(icp: IcpDoc, ledger: CostLedger): SynthesizeResult {
	return {
		query: icp.description,
		systemPrompt:
			"Extract the company name, domain, and one recent hiring or funding signal.",
		searchShape: { category: "company", type: "neural" },
		ledger,
	};
}

/**
 * Turns an ICP document plus any reject reasons from the previous round
 * into a search query, an extraction prompt, and a search shape that never
 * combines a company category with a date filter. Falls back to a
 * template query built from the ICP document when the model produces
 * nothing usable twice in a row.
 */
export async function synthesize(
	icp: IcpDoc,
	feedback: readonly string[],
	env: Env,
): Promise<SynthesizeResult> {
	const ledger = new CostLedger();
	const output = await generateStructured(
		{
			model: await workerModel(env),
			configuredId: env.MODEL_ROUTE_WORKER,
			instructions: SYNTHESIZE_INSTRUCTIONS,
			prompt: synthesizePrompt(icp, feedback),
			schema: SynthesizeModelSchema,
			headers: { "cf-aig-skip-cache": "true" },
		},
		ledger,
		"synthesize",
	);
	if (!output) return templateResult(icp, ledger);
	return {
		query: output.query,
		systemPrompt: output.systemPrompt,
		searchShape: normalizeSearchShape(output.searchShape),
		ledger,
	};
}
