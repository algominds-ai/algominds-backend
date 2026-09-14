import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { addPartialSpend, CostLedger, PartialSpendError } from "@/core/cost";
import { durablePurchase } from "@/workflows/durable-purchase";
import { fakeReplayingWorkflowStep, fakeWorkflowStep } from "../support/step";

const PURCHASE_CALL = { budget: "paidCall" as const };

describe("a paid durable step that retries before succeeding", () => {
	it("banks every attempt's reported spend once, not just the last one's", async () => {
		const { step, calls, sleepCalls } = fakeWorkflowStep();
		const ledger = new CostLedger();
		let attempt = 0;
		const value = await durablePurchase(
			{ step, name: "paid-step", ...PURCHASE_CALL, ledger },
			async (stepLedger) => {
				stepLedger.reported("exa", "search", 0.2);
				attempt += 1;
				if (attempt < 3) throw new Error("vendor blip");
				return { done: true };
			},
		);
		expect(value).toEqual({ done: true });
		expect(ledger.total()).toBeCloseTo(0.6, 9);
		expect(calls).toEqual([
			"paid-step-attempt-1",
			"paid-step-attempt-2",
			"paid-step-attempt-3",
		]);
		expect(sleepCalls.map((call) => call.name)).toEqual([
			"paid-step-wait-1",
			"paid-step-wait-2",
		]);
	});
});

describe("a paid durable step whose retries all fail", () => {
	it("fails the call with every attempt's spend already banked in the caller's ledger", async () => {
		const { step, calls } = fakeWorkflowStep();
		const ledger = new CostLedger();
		const failure = await durablePurchase(
			{ step, name: "paid-step", ...PURCHASE_CALL, ledger },
			async (stepLedger) => {
				stepLedger.reported("exa", "search", 0.2);
				throw new Error("vendor keeps failing");
			},
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(ledger.total()).toBeCloseTo(0.6, 9);
		expect(calls).toEqual([
			"paid-step-attempt-1",
			"paid-step-attempt-2",
			"paid-step-attempt-3",
		]);
	});
});

describe("a paid durable step that hits a terminal failure", () => {
	it("banks the reported spend and surfaces NonRetryableError without another attempt", async () => {
		const { step, calls } = fakeWorkflowStep();
		const ledger = new CostLedger();
		const failure = await durablePurchase(
			{ step, name: "paid-step", ...PURCHASE_CALL, ledger },
			async (stepLedger) => {
				stepLedger.reported("exa", "search", 0.2);
				throw new NonRetryableError("vendor says the request is invalid");
			},
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(NonRetryableError);
		expect(failure).not.toBeInstanceOf(PartialSpendError);
		expect(ledger.total()).toBeCloseTo(0.2, 9);
		expect(calls).toEqual(["paid-step-attempt-1"]);
	});

	it("unwraps a PartialSpendError whose cause is terminal the same way", async () => {
		const { step, calls } = fakeWorkflowStep();
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
		expect(calls).toEqual(["judge-step-attempt-1"]);
	});
});

describe("a paid durable step the engine restarts between attempts", () => {
	it("re-reads the recorded receipts instead of losing the first attempt's spend", async () => {
		const { step, calls } = fakeReplayingWorkflowStep();
		let buys = 0;
		const buy = async (stepLedger: CostLedger) => {
			stepLedger.reported("exa", "search", 0.2);
			buys += 1;
			if (buys === 1) throw new Error("vendor blip");
			return { done: true };
		};
		const restart = await durablePurchase(
			{ step, name: "paid-step", ...PURCHASE_CALL, ledger: new CostLedger() },
			buy,
		).catch((error: unknown) => error);
		expect(restart).toBeInstanceOf(Error);

		const ledger = new CostLedger();
		const value = await durablePurchase(
			{ step, name: "paid-step", ...PURCHASE_CALL, ledger },
			buy,
		);

		expect(value).toEqual({ done: true });
		expect(buys).toBe(2);
		expect(ledger.total()).toBeCloseTo(0.4, 9);
		expect(calls).toEqual(["paid-step-attempt-1", "paid-step-attempt-2"]);
	});
});
