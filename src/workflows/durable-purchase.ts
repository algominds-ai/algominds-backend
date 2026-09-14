import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type { CostEntry } from "@/core/cost";
import { CostLedger, PartialSpendError } from "@/core/cost";
import { applyCostEntries } from "@/workflows/agent-poll";

type PurchaseOutcome<T> =
	| { status: "pending" }
	| { status: "retryable"; error: string }
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
 * One attempt's receipt: the paid call reports into a ledger that dies with
 * the callback, and everything it reported returns inside the step result so
 * a replay rebuilds the spend from the recorded receipt instead of memory.
 */
async function purchaseAttempt<T>(
	buy: (ledger: CostLedger) => Promise<T>,
): Promise<PurchaseReceipt<T>> {
	const attemptLedger = new CostLedger();
	try {
		return {
			outcome: { status: "completed", output: await buy(attemptLedger) },
			costEntries: attemptLedger.toJSON().entries,
		};
	} catch (error) {
		const cause = error instanceof PartialSpendError ? error.cause : error;
		return {
			outcome:
				cause instanceof NonRetryableError
					? { status: "failed" as const, error: cause.message }
					: {
							status: "retryable" as const,
							error: cause instanceof Error ? cause.message : String(cause),
						},
			costEntries: attemptLedger.toJSON().entries,
		};
	}
}

function attemptStep<T>(
	ctx: PurchaseCall,
	index: number,
	buy: (ledger: CostLedger) => Promise<T>,
): Promise<PurchaseReceipt<T>> {
	return ctx.budget === "judgeCall"
		? ctx.step.do<PurchaseReceipt<T>>(
				`${ctx.name}-attempt-${index}`,
				config.stepConfig.judgeCall,
				() => purchaseAttempt(buy),
			)
		: ctx.step.do<PurchaseReceipt<T>>(
				`${ctx.name}-attempt-${index}`,
				config.stepConfig.paidCall,
				() => purchaseAttempt(buy),
			);
}

/** The error a non-completing outcome owes the round: a terminal failure stays a `NonRetryableError`, an exhausted retryable an ordinary one. */
function outcomeError(outcome: PurchaseOutcome<unknown>, name: string): Error {
	if (outcome.status === "failed") return new NonRetryableError(outcome.error);
	if (outcome.status === "retryable") return new Error(outcome.error);
	return new NonRetryableError(`${name} settled without an outcome`);
}

/**
 * Runs a paid call as one durable step per attempt, each resolving a receipt
 * that carries what the attempt reported spending, so an engine replay
 * re-applies recorded spend rather than repeating or losing it. A retryable
 * outcome sleeps and takes the next named attempt inside the budget's own
 * retry count and delay; a terminal one rethrows `NonRetryableError` once
 * its spend sits in the caller's ledger.
 */
export async function durablePurchase<T>(
	ctx: PurchaseCall,
	buy: (ledger: CostLedger) => Promise<T>,
): Promise<T> {
	const budget =
		ctx.budget === "judgeCall"
			? config.stepConfig.judgeCall
			: config.stepConfig.paidCall;
	for (let index = 1; index <= budget.retries.limit + 1; index += 1) {
		const receipt = await attemptStep(ctx, index, buy);
		applyCostEntries(receipt.costEntries, ctx.ledger);
		const { outcome } = receipt;
		if (outcome.status === "completed") return outcome.output;
		if (outcome.status === "retryable" && index <= budget.retries.limit) {
			await ctx.step.sleep(`${ctx.name}-wait-${index}`, budget.retries.delay);
			continue;
		}
		throw outcomeError(outcome, ctx.name);
	}
	throw new NonRetryableError(`${ctx.name} settled without an outcome`);
}
