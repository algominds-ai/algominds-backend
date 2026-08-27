import type { Provider } from "@/core/providers/types";

export class RetryableProviderError extends Error {}

export async function waterfall<I, O>(
	providers: Provider<I, O>[],
	input: I,
	env: Env,
	accept: (output: O) => boolean = () => true,
): Promise<{ output: O; source: string } | null> {
	for (const provider of providers) {
		const output = await provider.run(input, env).catch((error: unknown) => {
			if (error instanceof RetryableProviderError) throw error;
			return null;
		});
		if (output && accept(output)) return { output, source: provider.id };
	}
	return null;
}
