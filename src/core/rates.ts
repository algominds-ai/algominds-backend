export type Unit =
	| "dollars"
	| "tokens_in"
	| "tokens_out"
	| "credits"
	| "verifier_credits"
	| "records"
	| "calls";

/** Dollar rate per unit for every vendor `CostLedger.metered()` prices. */
export const RATES: Record<string, Partial<Record<Unit, number>>> = {
	findymail: { credits: 0.01, verifier_credits: 0.01 },
	clay: { records: 0 },
};
