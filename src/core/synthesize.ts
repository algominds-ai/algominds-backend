import { z } from "zod";
import { CostLedger } from "@/core/cost";
import { generateStructured, workerModel } from "@/core/model";

export const IcpDocSchema = z.object({
	industry: z.string(),
	stage: z.string(),
	geography: z.string(),
	product: z.string().optional(),
});

export type IcpDoc = z.infer<typeof IcpDocSchema>;

const DATA_SOURCES = ["fiber", "similarweb"] as const;
type DataSource = (typeof DATA_SOURCES)[number];
const DATA_SOURCE_NAMES: ReadonlySet<string> = new Set(DATA_SOURCES);
const MAX_DATA_SOURCES = 5;

function isDataSource(value: string): value is DataSource {
	return DATA_SOURCE_NAMES.has(value);
}

const SynthesizeModelSchema = z.object({
	query: z.string(),
	systemPrompt: z.string(),
	dataSources: z.array(z.string()),
});

export type SynthesizeResult = {
	query: string;
	systemPrompt: string;
	dataSources: DataSource[];
	ledger: CostLedger;
};

const SYNTHESIZE_INSTRUCTIONS = [
	"You write one search request for a round of company discovery against an ideal customer",
	"profile. Return a query string, a system prompt telling the search step what to extract",
	"from each result, and up to five data source slugs to enrich each company with. Keep the",
	"query specific to the industry, stage, and geography given. When rejection reasons are",
	"given, change the query enough to reach different companies without dropping any of the",
	"three scoping terms.",
].join(" ");

function synthesizePrompt(icp: IcpDoc, feedback: readonly string[]): string {
	const lines = [
		`Industry: ${icp.industry}`,
		`Stage: ${icp.stage}`,
		`Geography: ${icp.geography}`,
	];
	if (icp.product) lines.push(`Product: ${icp.product}`);
	if (feedback.length > 0) {
		lines.push("Reasons the previous round's companies were rejected:");
		for (const reason of feedback) lines.push(`- ${reason}`);
	}
	return lines.join("\n");
}

function templateResult(icp: IcpDoc, ledger: CostLedger): SynthesizeResult {
	return {
		query: `${icp.industry} companies at ${icp.stage} stage in ${icp.geography}`,
		systemPrompt:
			"Extract the company name, domain, and one recent hiring or funding signal.",
		dataSources: [],
		ledger,
	};
}

/**
 * Turns an ICP document plus any reject reasons from the previous round
 * into a search query, an extraction prompt, and a capped list of
 * enrichment data sources. Falls back to a template query built from the
 * ICP document when the model produces nothing usable twice in a row.
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
		dataSources: output.dataSources
			.filter(isDataSource)
			.slice(0, MAX_DATA_SOURCES),
		ledger,
	};
}
