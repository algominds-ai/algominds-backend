export type Unit =
	| "dollars"
	| "tokens_in"
	| "tokens_out"
	| "credits"
	| "records"
	| "calls";

/** Dollar rate per unit for every vendor `CostLedger.metered()` prices. */
export const RATES: Record<string, Partial<Record<Unit, number>>> = {
	findymail: { credits: 0.01 },
};
