import { describe, expect, it } from "vitest";
import { isSpendLimitExceeded } from "@/core/cost";

describe("isSpendLimitExceeded", () => {
	it("classifies a 429 by its message and envelope, never an ordinary rate limit or a non-429 status", () => {
		expect(
			isSpendLimitExceeded(429, { error: { message: "spend limit exceeded" } }),
		).toBe(true);
		expect(
			isSpendLimitExceeded(429, { error: { message: "too many requests" } }),
		).toBe(false);
		expect(
			isSpendLimitExceeded(500, { error: { message: "spend limit exceeded" } }),
		).toBe(false);
		expect(isSpendLimitExceeded(429, { message: "spend limit exceeded" })).toBe(
			false,
		);
		expect(isSpendLimitExceeded(429, null)).toBe(false);
	});
});
