import type { CostLedger } from "@/core/cost";
import type { Provider } from "@/core/providers/types";

export class RetryableProviderError extends Error {}

export type WaterfallOptions<O> = {
	accept?: (output: O) => boolean;
	ledger?: CostLedger;
};

/**
 * Runs `providers` in order until one hits, passing `options.ledger` to
 * every attempt so a miss still records whatever it spent. Rethrows a
 * `RetryableProviderError`; any other throw is treated as a miss.
 */
export async function waterfall<I, O>(
	providers: Provider<I, O>[],
	input: I,
	env: Env,
	options: WaterfallOptions<O> = {},
): Promise<{ output: O; source: string } | null> {
	const accept = options.accept ?? (() => true);
	for (const provider of providers) {
		const output = await provider
			.run(input, env, options.ledger)
			.catch((error: unknown) => {
				if (error instanceof RetryableProviderError) throw error;
				return null;
			});
		if (output && accept(output)) return { output, source: provider.id };
	}
	return null;
}
