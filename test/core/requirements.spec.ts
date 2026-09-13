import { describe, expect, it } from "vitest";
import type { Condition } from "@/core/requirements";
import { conditionDateAllowed, windowBoundary } from "@/core/requirements";

function condition(window: NonNullable<Condition["window"]> | null): Condition {
	return { text: "signal", window, sourceRule: null };
}

describe("requirement date windows", () => {
	it("handles inclusive past and future day windows", () => {
		const past = condition({
			amount: 7,
			unit: "days",
			appliesTo: "publication",
			direction: "past",
		});
		const pastWindow = past.window;
		if (!pastWindow) throw new Error("expected a bounded condition");
		const future = condition({ ...pastWindow, direction: "future" });
		expect(windowBoundary(past.window, "2026-09-06")).toBe("2026-08-30");
		expect(conditionDateAllowed(past, "2026-08-30", "2026-09-06")).toBe(true);
		expect(conditionDateAllowed(past, "2026-09-07", "2026-09-06")).toBe(false);
		expect(conditionDateAllowed(future, "2026-09-06", "2026-09-06")).toBe(true);
		expect(conditionDateAllowed(future, "2026-09-14", "2026-09-06")).toBe(
			false,
		);
	});

	it("clamps month ends and leap years", () => {
		const month = {
			amount: 1,
			unit: "months" as const,
			appliesTo: "publication" as const,
			direction: "past" as const,
		};
		const year = { ...month, amount: 1, unit: "years" as const };
		expect(windowBoundary(month, "2026-03-31")).toBe("2026-02-28");
		expect(
			windowBoundary({ ...month, direction: "future" }, "2024-01-31"),
		).toBe("2024-02-29");
		expect(windowBoundary(year, "2024-02-29")).toBe("2023-02-28");
	});

	it("rejects missing or invalid dates only when a window is present", () => {
		const bounded = condition({
			amount: 1,
			unit: "days",
			appliesTo: "publication",
			direction: "past",
		});
		expect(conditionDateAllowed(bounded, null, "2026-09-06")).toBe(false);
		expect(conditionDateAllowed(bounded, "2026-02-30", "2026-09-06")).toBe(
			false,
		);
		expect(conditionDateAllowed(condition(null), null, "2026-09-06")).toBe(
			true,
		);
		expect(
			conditionDateAllowed(condition(null), "2026-02-30", "2026-09-06"),
		).toBe(false);
	});
});
