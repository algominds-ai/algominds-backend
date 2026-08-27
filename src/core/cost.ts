import { z } from "zod";
import type { Pricing, Unit } from "@/core/rates";
import { modelRate, rateFor } from "@/core/rates";

export type CostEntry = {
	provider: string;
	op: string;
	dollars: number;
};

export type CostSummary = {
	total: number;
	byProvider: Record<string, number>;
	entries: CostEntry[];
};

const MICROS_PER_DOLLAR = 1_000_000;

function toMicros(dollars: number): number {
	return Math.round(dollars * MICROS_PER_DOLLAR);
}

function toDollars(micros: number): number {
	return micros / MICROS_PER_DOLLAR;
}

/**
 * Accumulates dollar cost across external calls. Amounts are stored as
 * integer micro-dollars so `total()` and `byProvider()` never drift apart
 * over floating-point rounding.
 */
export class CostLedger {
	#entries: Array<{ provider: string; op: string; micros: number }> = [];

	/**
	 * Records a dollar figure a vendor returned directly. When `detail` is
	 * given, it replaces the flat figure with one line per key instead of one
	 * line for `provider`.
	 */
	reported(
		provider: string,
		op: string,
		dollars: number,
		detail?: Record<string, number>,
	): void {
		if (!detail || Object.keys(detail).length === 0) {
			this.#entries.push({ provider, op, micros: toMicros(dollars) });
			return;
		}
		for (const [name, amount] of Object.entries(detail)) {
			this.#entries.push({ provider: name, op, micros: toMicros(amount) });
		}
	}

	/**
	 * Records `units x` the configured rate for `provider`/`unit`. Throws
	 * when no rate is configured, rather than recording a silent zero.
	 */
	metered(provider: string, op: string, units: number, unit: Unit): void {
		const rate = rateFor(provider, unit);
		if (rate === undefined) {
			throw new Error(
				`CostLedger.metered: no rate configured for provider "${provider}" unit "${unit}"`,
			);
		}
		this.#entries.push({ provider, op, micros: toMicros(units * rate) });
	}

	total(): number {
		const sum = this.#entries.reduce((acc, entry) => acc + entry.micros, 0);
		return toDollars(sum);
	}

	byProvider(): Record<string, number> {
		const micros = new Map<string, number>();
		for (const entry of this.#entries) {
			micros.set(
				entry.provider,
				(micros.get(entry.provider) ?? 0) + entry.micros,
			);
		}
		return Object.fromEntries(
			Array.from(micros, ([provider, m]) => [provider, toDollars(m)]),
		);
	}

	toJSON(): CostSummary {
		return {
			total: this.total(),
			byProvider: this.byProvider(),
			entries: this.#entries.map((entry) => ({
				provider: entry.provider,
				op: entry.op,
				dollars: toDollars(entry.micros),
			})),
		};
	}

	/** Concatenates every ledger's entries into a new ledger. */
	static merge(...ledgers: CostLedger[]): CostLedger {
		const merged = new CostLedger();
		for (const ledger of ledgers) {
			merged.#entries.push(...ledger.#entries);
		}
		return merged;
	}
}

/** True when the AI Gateway served this response from cache. */
export function isGatewayCacheHit(headers: Headers): boolean {
	return headers.get("cf-aig-cache-status") === "HIT";
}

/**
 * Resolves the model id a response actually used: the gateway's header,
 * then the response body, then the id the caller configured.
 */
export function resolveModelId(
	headers: Headers,
	responseModelId: string | undefined,
	configuredId: string,
): string {
	const fromHeader = headers.get("cf-aig-model");
	if (fromHeader) return fromHeader;
	if (responseModelId) return responseModelId;
	console.warn(
		`cost: cf-aig-model header and response.modelId were both absent; pricing "${configuredId}" as configured`,
	);
	return configuredId;
}

/** Builds the `cf-aig-custom-cost` request header body for one model's price. */
export function customCostHeader(pricing: Pricing): string {
	return JSON.stringify({
		per_token_in: pricing.prompt,
		per_token_out: pricing.completion,
	});
}

export type ModelCallResult = {
	headers: Headers;
	responseModelId?: string;
	usage: { inputTokens: number; outputTokens: number };
};

/**
 * Records one model call into `ledger`: zero on a cache hit, otherwise the
 * resolved model's tokens at its OpenRouter rate.
 */
export async function recordModelCall(
	ledger: CostLedger,
	op: string,
	configuredId: string,
	result: ModelCallResult,
): Promise<void> {
	const modelId = resolveModelId(
		result.headers,
		result.responseModelId,
		configuredId,
	);
	if (isGatewayCacheHit(result.headers)) {
		ledger.reported(modelId, op, 0);
		return;
	}
	await modelRate(modelId);
	ledger.metered(modelId, op, result.usage.inputTokens, "tokens_in");
	ledger.metered(modelId, op, result.usage.outputTokens, "tokens_out");
}

const SpendLimitErrorSchema = z.object({
	error: z.object({ message: z.string() }),
});

/** True when a 429 is an AI Gateway spend-limit block rather than a transient rate limit. */
export function isSpendLimitExceeded(status: number, body: unknown): boolean {
	if (status !== 429) return false;
	const parsed = SpendLimitErrorSchema.safeParse(body);
	if (!parsed.success) return false;
	return /spend limit|budget/i.test(parsed.data.error.message);
}
