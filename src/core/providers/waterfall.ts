import type { Provider } from "@/core/providers/types";

// A retryable miss (e.g. a 429) must reach `step.do` so its retry config can
// act on it. Every other throw is an ordinary miss and the waterfall moves on.
export class RetryableProviderError extends Error {}

export async function waterfall<I, O extends Record<string, unknown>>(
	providers: Provider<I, O>[],
	input: I,
	env: Env,
	accept: (output: O) => boolean = () => true,
): Promise<(O & { source: string }) | null> {
	for (const provider of providers) {
		const output = await provider.run(input, env).catch((error: unknown) => {
			if (error instanceof RetryableProviderError) throw error;
			return null; // a miss, try the next provider
		});
		if (output && accept(output)) return { ...output, source: provider.id };
	}
	return null;
}
