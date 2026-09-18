import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CostLedger } from "../../src/core/cost";
import type { Provider } from "../../src/core/providers/types";
import {
	RetryableProviderError,
	waterfall,
} from "../../src/core/providers/waterfall";

type Out = { value?: string; status?: string };

function provider(
	id: string,
	run: (input: Out, env: Env) => Promise<Out | null>,
): Provider<Out, Out> {
	return { id, run };
}

describe("waterfall", () => {
	it("moves to the next provider when the first misses, and returns null when every provider misses", async () => {
		const calls: string[] = [];
		const first = provider("first", async () => {
			calls.push("first");
			return null;
		});
		const second = provider("second", async () => {
			calls.push("second");
			return { value: "b" };
		});

		const hit = await waterfall([first, second], {}, testEnv);
		expect(hit).toEqual({ output: { value: "b" }, source: "second" });
		expect(calls).toEqual(["first", "second"]);

		const miss = await waterfall(
			[provider("a", async () => null), provider("b", async () => null)],
			{},
			testEnv,
		);
		expect(miss).toBeNull();
	});

	it("swallows an ordinary throw and reaches the next provider", async () => {
		const first = provider("first", async () => {
			throw new Error("vendor exploded");
		});
		const second = provider("second", async () => ({ value: "b" }));

		const result = await waterfall([first, second], {}, testEnv);

		expect(result).toEqual({ output: { value: "b" }, source: "second" });
	});

	it("re-throws a retryable provider error and does not call the next provider", async () => {
		const calls: string[] = [];
		const first = provider("first", async () => {
			calls.push("first");
			throw new RetryableProviderError("429");
		});
		const second = provider("second", async () => {
			calls.push("second");
			return { value: "b" };
		});

		await expect(waterfall([first, second], {}, testEnv)).rejects.toThrow(
			RetryableProviderError,
		);
		expect(calls).toEqual(["first"]);
	});

	it("does not stop on a hit the accept predicate rejects", async () => {
		const calls: string[] = [];
		const first = provider("first", async () => {
			calls.push("first");
			return { status: "guessed" };
		});
		const second = provider("second", async () => {
			calls.push("second");
			return { status: "verified" };
		});

		const result = await waterfall([first, second], {}, testEnv, {
			accept: (o) => o.status === "verified",
		});

		expect(result).toEqual({
			output: { status: "verified" },
			source: "second",
		});
		expect(calls).toEqual(["first", "second"]);
	});
});

describe("waterfall: spend tracking", () => {
	it("passes the ledger to every provider, so a miss still records what it spent", async () => {
		const first: Provider<Out, Out> = {
			id: "first",
			async run(_input, _env, ledger) {
				ledger?.reported("first", "attempt", 0.01);
				return null;
			},
		};
		const second: Provider<Out, Out> = {
			id: "second",
			async run(_input, _env, ledger) {
				ledger?.reported("second", "attempt", 0.02);
				return { value: "b" };
			},
		};
		const ledger = new CostLedger();

		const result = await waterfall([first, second], {}, testEnv, { ledger });

		expect(result).toEqual({ output: { value: "b" }, source: "second" });
		expect(ledger.total()).toBeCloseTo(0.03, 10);
	});
});
