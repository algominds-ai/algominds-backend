import type { CostLedger } from "@/core/cost";

export type Channel =
	| "company"
	| "people"
	| "employment"
	| "email"
	| "linkedin";

/**
 * A single vendor lookup a waterfall can try. `ledger`, when given, records
 * whatever the run spent even on a miss; a provider with nothing to report
 * simply leaves it untouched.
 */
export type Provider<I, O> = {
	id: string;
	channels: Channel[];
	cost: number;
	run(input: I, env: Env, ledger?: CostLedger): Promise<O | null>;
};
