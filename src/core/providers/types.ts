import type { CostLedger } from "@/core/cost";

/**
 * A single vendor lookup a waterfall can try. `ledger`, when given, records
 * whatever the run spent even on a miss; a provider with nothing to report
 * simply leaves it untouched.
 */
export type Provider<I, O> = {
	id: string;
	run(input: I, env: Env, ledger?: CostLedger): Promise<O | null>;
};
