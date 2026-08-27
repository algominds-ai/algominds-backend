import { z } from "zod";

export type Unit =
	| "dollars"
	| "tokens_in"
	| "tokens_out"
	| "credits"
	| "records"
	| "calls";

/** A model's per-token price, already parsed out of OpenRouter's decimal strings. */
export type Pricing = {
	prompt: number;
	completion: number;
};

/** Dollar rate per unit for every vendor billed outside per-token model pricing. */
export const RATES: Record<string, Partial<Record<Unit, number>>> = {
	apollo: { credits: 0.01 },
	brightdata: { records: 0.0025 },
};

/** Model ids the AI Gateway dynamic route can serve, primary and fallback alike. */
export const MODELS_IN_USE: ReadonlySet<string> = new Set([
	"anthropic/claude-sonnet-4.5",
	"openai/gpt-4.1-mini",
]);

/** Pinned per-token prices used when the OpenRouter price fetch fails. */
export const FALLBACK: Record<string, Pricing> = {
	"anthropic/claude-sonnet-4.5": { prompt: 0.000003, completion: 0.000015 },
	"openai/gpt-4.1-mini": { prompt: 0.0000004, completion: 0.0000016 },
};

const OpenRouterModelSchema = z.object({
	id: z.string(),
	pricing: z.object({
		prompt: z.string(),
		completion: z.string(),
	}),
});

const OpenRouterModelsResponseSchema = z.object({
	data: z.array(OpenRouterModelSchema),
});

let memo: Record<string, Pricing> | null = null;
let inFlight: Promise<Record<string, Pricing> | null> | null = null;
const resolvedModelRates = new Map<string, Pricing>();

/**
 * Resolves a model's per-token price. Fetches and memoizes OpenRouter's
 * price list once per isolate, falling back to a pinned constant on failure.
 */
export async function modelRate(id: string): Promise<Pricing> {
	if (!memo) {
		if (!inFlight) {
			inFlight = fetchModelPrices().finally(() => {
				inFlight = null;
			});
		}
		const fetched = await inFlight;
		if (fetched) memo = fetched;
	}
	const pricing = memo?.[id] ?? FALLBACK[id];
	if (!pricing) {
		throw new Error(`modelRate: no price known for model "${id}"`);
	}
	resolvedModelRates.set(id, pricing);
	return pricing;
}

async function fetchModelPrices(): Promise<Record<string, Pricing> | null> {
	try {
		const res = await fetch("https://openrouter.ai/api/v1/models", {
			cf: { cacheTtl: 86400, cacheEverything: true },
		});
		if (!res.ok) return null;
		const json: unknown = await res.json();
		const parsed = OpenRouterModelsResponseSchema.safeParse(json);
		if (!parsed.success) return null;
		const entries: Array<[string, Pricing]> = [];
		for (const model of parsed.data.data) {
			if (!MODELS_IN_USE.has(model.id)) continue;
			entries.push([
				model.id,
				{
					prompt: Number(model.pricing.prompt),
					completion: Number(model.pricing.completion),
				},
			]);
		}
		return Object.fromEntries(entries);
	} catch {
		return null;
	}
}

/**
 * Looks up the dollar rate for one provider and unit: the static table
 * first, then any model price {@link modelRate} has already resolved.
 */
export function rateFor(provider: string, unit: Unit): number | undefined {
	const staticRate = RATES[provider]?.[unit];
	if (staticRate !== undefined) return staticRate;
	const pricing = resolvedModelRates.get(provider);
	if (!pricing) return undefined;
	if (unit === "tokens_in") return pricing.prompt;
	if (unit === "tokens_out") return pricing.completion;
	return undefined;
}
