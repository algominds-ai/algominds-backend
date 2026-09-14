import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { addPartialSpend, CostLedger, PartialSpendError } from "@/core/cost";
import { applyCostEntries } from "@/workflows/agent-poll";

type PurchaseOutcome<T> =
	| { status: "pending" }
	| { status: "completed"; output: T }
	| { status: "failed"; error: string };

type PurchaseReceipt<T> = {
	outcome: PurchaseOutcome<T>;
	costEntries: CostEntry[];
};

type PurchaseCall = {
	step: WorkflowStep;
	name: string;
	budget: "paidCall" | "judgeCall";
	ledger: CostLedger;
};

/**
 * The receipt a terminal failure still earns: the spend it reported travels
 * back inside the receipt instead of dying with the callback's throw. Null
 * for anything retryable.
 */
function failedReceipt<T>(
	stepLedger: CostLedger,
	error: unknown,
): PurchaseReceipt<T> | null {
	const cause = error instanceof PartialSpendError ? error.cause : error;
	if (!(cause instanceof NonRetryableError)) return null;
	return {
		outcome: { status: "failed", error: cause.message },
		costEntries: stepLedger.toJSON().entries,
	};
}

/**
 * Runs one paid durable step against a ledger that outlives the step's own
 * retries, so every attempt's reported spend survives exactly once: applied
 * to `ctx.ledger` from the resolved receipt, or carried by the thrown
 * `PartialSpendError` once a retryable failure spends the retry budget. A
 * terminal failure resolves its receipt instead, then rethrows as
 * `NonRetryableError` outside the paid callback so nothing repeats paid work.
 */
export async function durablePurchase<T>(
	ctx: PurchaseCall,
	buy: (ledger: CostLedger) => Promise<T>,
): Promise<T> {
	const stepLedger = new CostLedger();
	const attempt = async (): Promise<PurchaseReceipt<T>> => {
		try {
			return {
				outcome: { status: "completed", output: await buy(stepLedger) },
				costEntries: stepLedger.toJSON().entries,
			};
		} catch (error) {
			const failed = failedReceipt<T>(stepLedger, error);
			if (failed) return failed;
			throw error instanceof PartialSpendError
				? error
				: addPartialSpend(error, stepLedger.total());
		}
	};
	const settled =
		ctx.budget === "judgeCall"
			? await ctx.step.do(ctx.name, config.stepConfig.judgeCall, attempt)
			: await ctx.step.do(ctx.name, config.stepConfig.paidCall, attempt);
	applyCostEntries(settled.costEntries, ctx.ledger);
	if (settled.outcome.status === "failed")
		throw new NonRetryableError(settled.outcome.error);
	if (settled.outcome.status !== "completed")
		throw new NonRetryableError(`${ctx.name} settled without an outcome`);
	return settled.outcome.output;
}
