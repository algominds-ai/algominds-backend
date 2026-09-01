import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
	generateText,
	NoObjectGeneratedError,
	NoOutputGeneratedError,
	Output,
} from "ai";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { recordModelCall } from "@/core/cost";

const PROVIDER_NAME = "aigw";

/**
 * `supportsStructuredOutputs` makes the SDK send the real JSON schema
 * instead of a bare `json_object`, and `require_parameters` makes OpenRouter
 * pick a provider that honours it. See
 * `docs/solutions/structured-output-routing.md`.
 */
const STRUCTURED_ROUTING = {
	[PROVIDER_NAME]: {
		provider: { require_parameters: true },
	},
};

async function gatewayModel(env: Env, route: string): Promise<LanguageModel> {
	const token = await env.CF_AIG_TOKEN.get();
	return createOpenAICompatible({
		name: PROVIDER_NAME,
		baseURL: env.AI_GATEWAY_BASE_URL,
		headers: { "cf-aig-authorization": `Bearer ${token}` },
		supportsStructuredOutputs: true,
	}).chatModel(route);
}

/**
 * The stronger route. The judge decides which companies reach a campaign,
 * so it runs on the model with more reasoning behind it.
 */
export async function reasoningModel(env: Env): Promise<LanguageModel> {
	return gatewayModel(env, env.MODEL_ROUTE_REASONING);
}

/**
 * The lighter route. The synthesizer only has to write one competent
 * search request per round.
 */
export async function workerModel(env: Env): Promise<LanguageModel> {
	return gatewayModel(env, env.MODEL_ROUTE_WORKER);
}

const GatewayResponseBodySchema = z.object({
	usage: z.object({ cost: z.number() }).nullish(),
});

function costFromResponseBody(body: unknown): number {
	const parsed = GatewayResponseBodySchema.safeParse(body);
	return parsed.success ? (parsed.data.usage?.cost ?? 0) : 0;
}

function isRetryableModelError(error: unknown): boolean {
	return (
		NoObjectGeneratedError.isInstance(error) ||
		NoOutputGeneratedError.isInstance(error)
	);
}

export type StructuredCallParams<T> = {
	model: LanguageModel;
	configuredId: string;
	instructions: string;
	prompt: string;
	schema: z.ZodType<T>;
	headers: Record<string, string>;
};

async function attemptStructured<T>(
	params: StructuredCallParams<T>,
	ledger: CostLedger,
	op: string,
): Promise<T> {
	try {
		const result = await generateText({
			model: params.model,
			instructions: params.instructions,
			prompt: params.prompt,
			output: Output.object({ schema: params.schema }),
			headers: params.headers,
			providerOptions: STRUCTURED_ROUTING,
			include: { responseBody: true },
		});
		recordModelCall(ledger, op, params.configuredId, {
			headers: new Headers(result.response.headers),
			responseModelId: result.response.modelId,
			usage: { cost: costFromResponseBody(result.response.body) },
		});
		return result.output;
	} catch (error) {
		if (NoObjectGeneratedError.isInstance(error) && error.response) {
			recordModelCall(ledger, op, params.configuredId, {
				headers: new Headers(error.response.headers),
				responseModelId: error.response.modelId,
				usage: { cost: costFromResponseBody(error.response.body) },
			});
		}
		throw error;
	}
}

/**
 * Runs one structured model call and retries once when the model returns
 * nothing usable. Returns `null` after a second failure instead of
 * throwing, so the caller can fall back to a safe default.
 */
export async function generateStructured<T>(
	params: StructuredCallParams<T>,
	ledger: CostLedger,
	op: string,
): Promise<T | null> {
	try {
		return await attemptStructured(params, ledger, op);
	} catch (firstError) {
		if (!isRetryableModelError(firstError)) throw firstError;
	}
	try {
		return await attemptStructured(params, ledger, op);
	} catch (secondError) {
		if (!isRetryableModelError(secondError)) throw secondError;
		return null;
	}
}
