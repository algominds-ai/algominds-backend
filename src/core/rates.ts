export type Unit =
	| "dollars"
	| "tokens_in"
	| "tokens_out"
	| "credits"
	| "records"
	| "calls";

/** Dollar rate per unit for every vendor `CostLedger.metered()` prices. */
export const RATES: Record<string, Partial<Record<Unit, number>>> = {
	apollo: { credits: 0.01 },
	brightdata: { records: 0.0025 },
};

export type ExaEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Exa's flat per-request price at each effort tier. */
export const EXA_EFFORT_DOLLARS: Record<ExaEffort, number> = {
	minimal: 0.012,
	low: 0.025,
	medium: 0.1,
	high: 0.5,
	xhigh: 1,
};
