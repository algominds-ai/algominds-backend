import { z } from "zod";
import type { Unit } from "@/core/rates";
import { RATES } from "@/core/rates";

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

const NANOS_PER_DOLLAR = 1_000_000_000;

function toNanos(dollars: number): number {
	return Math.round(dollars * NANOS_PER_DOLLAR);
}

function toDollars(nanos: number): number {
	return nanos / NANOS_PER_DOLLAR;
}

/**
 * Accumulates dollar cost across external calls. Amounts are stored as
 * integer nano-dollars so `total()` and `byProvider()` never drift apart
 * over floating-point rounding.
 */
export class CostLedger {
	#entries: Array<{ provider: string; op: string; nanos: number }> = [];

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
			this.#entries.push({ provider, op, nanos: toNanos(dollars) });
			return;
		}
		for (const [name, amount] of Object.entries(detail)) {
			this.#entries.push({ provider: name, op, nanos: toNanos(amount) });
		}
	}

	/**
	 * Records `units x` the configured rate for `provider`/`unit`. Throws
	 * when no rate is configured, rather than recording a silent zero.
	 */
	metered(provider: string, op: string, units: number, unit: Unit): void {
		const rate = RATES[provider]?.[unit];
		if (rate === undefined) {
			throw new Error(
				`CostLedger.metered: no rate configured for provider "${provider}" unit "${unit}"`,
			);
		}
		this.#entries.push({ provider, op, nanos: toNanos(units * rate) });
	}

	total(): number {
		const sum = this.#entries.reduce((acc, entry) => acc + entry.nanos, 0);
		return toDollars(sum);
	}

	byProvider(): Record<string, number> {
		const nanos = new Map<string, number>();
		for (const entry of this.#entries) {
			nanos.set(entry.provider, (nanos.get(entry.provider) ?? 0) + entry.nanos);
		}
		return Object.fromEntries(
			Array.from(nanos, ([provider, m]) => [provider, toDollars(m)]),
		);
	}

	toJSON(): CostSummary {
		return {
			total: this.total(),
			byProvider: this.byProvider(),
			entries: this.#entries.map((entry) => ({
				provider: entry.provider,
				op: entry.op,
				dollars: toDollars(entry.nanos),
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

/**
 * Carries a round's own partial spend up through whatever it was doing when
 * it threw, so the caller that lost the round can still bank what it paid
 * for. `cause` is the error that actually stopped the round.
 */
export class PartialSpendError extends Error {
	readonly costDollars: number;

	constructor(costDollars: number, cause: unknown) {
		super("a round failed after it had already spent", { cause });
		this.name = "PartialSpendError";
		this.costDollars = costDollars;
	}
}

/** Folds `priorSpend` onto whatever `error` already carries, keeping the original cause rather than nesting wrappers. */
export function addPartialSpend(
	error: unknown,
	priorSpend: number,
): PartialSpendError {
	if (error instanceof PartialSpendError) {
		return new PartialSpendError(priorSpend + error.costDollars, error.cause);
	}
	return new PartialSpendError(priorSpend, error);
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

export type ModelCallResult = {
	headers: Headers;
	responseModelId?: string;
	usage: { cost: number };
};

/**
 * Records one model call into `ledger`: zero on a cache hit, otherwise the
 * dollar cost the gateway returned for the resolved model.
 */
export function recordModelCall(
	ledger: CostLedger,
	op: string,
	configuredId: string,
	result: ModelCallResult,
): void {
	const modelId = resolveModelId(
		result.headers,
		result.responseModelId,
		configuredId,
	);
	if (isGatewayCacheHit(result.headers)) {
		ledger.reported(modelId, op, 0);
		return;
	}
	ledger.reported(modelId, op, result.usage.cost);
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
