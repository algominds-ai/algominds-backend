import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { addPartialSpend, CostLedger, PartialSpendError } from "@/core/cost";
import { durablePurchase } from "@/workflows/durable-purchase";
import { fakeRetryingWorkflowStep } from "../support/step";

function spent(error: unknown): number {
	if (!(error instanceof PartialSpendError)) throw error;
	return error.costDollars;
}

describe("a paid durable step that retries before succeeding", () => {
	it("banks every attempt's reported spend once, not just the last one's", async () => {
		const { step, calls } = fakeRetryingWorkflowStep();
		const ledger = new CostLedger();
		let attempt = 0;
		const value = await durablePurchase(
			{ step, name: "paid-step", budget: "paidCall", ledger },
			async (stepLedger) => {
				stepLedger.reported("exa", "search", 0.2);
				attempt += 1;
				if (attempt < 3) throw new Error("vendor blip");
				return { done: true };
			},
		);
		expect(value).toEqual({ done: true });
		expect(ledger.total()).toBeCloseTo(0.6, 9);
		expect(calls.filter((name) => name === "paid-step")).toHaveLength(3);
	});
});

describe("a paid durable step whose retries all fail", () => {
	it("carries every attempt's spend in the thrown PartialSpendError", async () => {
		const { step, calls } = fakeRetryingWorkflowStep();
		const ledger = new CostLedger();
		const failure = await durablePurchase(
			{ step, name: "paid-step", budget: "paidCall", ledger },
			async (stepLedger) => {
				stepLedger.reported("exa", "search", 0.2);
				throw new Error("vendor keeps failing");
			},
		).catch((error: unknown) => error);
		expect(spent(failure)).toBeCloseTo(0.6, 9);
		expect(ledger.total()).toBe(0);
		expect(calls.filter((name) => name === "paid-step")).toHaveLength(3);
	});
});

describe("a paid durable step that hits a terminal failure", () => {
	it("banks the reported spend and surfaces NonRetryableError without another attempt", async () => {
		const { step, calls } = fakeRetryingWorkflowStep();
		const ledger = new CostLedger();
		const failure = await durablePurchase(
			{ step, name: "paid-step", budget: "paidCall", ledger },
			async (stepLedger) => {
				stepLedger.reported("exa", "search", 0.2);
				throw new NonRetryableError("vendor says the request is invalid");
			},
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(NonRetryableError);
		expect(failure).not.toBeInstanceOf(PartialSpendError);
		expect(ledger.total()).toBeCloseTo(0.2, 9);
		expect(calls).toEqual(["paid-step"]);
	});

	it("unwraps a PartialSpendError whose cause is terminal the same way", async () => {
		const { step, calls } = fakeRetryingWorkflowStep();
		const ledger = new CostLedger();
		const failure = await durablePurchase(
			{ step, name: "judge-step", budget: "judgeCall", ledger },
			async (stepLedger) => {
				stepLedger.reported("model", "judge", 0.2);
				throw addPartialSpend(
					new NonRetryableError("the judge gave up"),
					stepLedger.total(),
				);
			},
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(NonRetryableError);
		expect(ledger.total()).toBeCloseTo(0.2, 9);
		expect(calls).toEqual(["judge-step"]);
	});
});
