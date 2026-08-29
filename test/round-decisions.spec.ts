import { describe, expect, it } from "vitest";
import { decideRound, terminalStatus } from "../src/core/companies";

describe("what a finished round means for the loop", () => {
	it("stops as complete once the round reaches the count the caller asked for", () => {
		expect(decideRound(2, 2, { resultCount: 100, unseenCount: 40 })).toBe(
			"complete",
		);
	});

	it("retries a round the vendor answered with nothing, because the query was too narrow", () => {
		expect(decideRound(0, 1, { resultCount: 0, unseenCount: 0 })).toBe("retry");
	});

	it("stops as exhausted when the vendor answered but every company was already seen", () => {
		expect(decideRound(0, 1, { resultCount: 100, unseenCount: 0 })).toBe(
			"exhausted",
		);
	});

	it("keeps going when the round found companies but not yet enough", () => {
		expect(decideRound(1, 3, { resultCount: 100, unseenCount: 20 })).toBe(
			"continue",
		);
	});

	it("tells an empty vendor answer apart from a market already covered", () => {
		const empty = decideRound(0, 1, { resultCount: 0, unseenCount: 0 });
		const covered = decideRound(0, 1, { resultCount: 100, unseenCount: 0 });

		expect(empty).not.toBe(covered);
	});
});

describe("the status a run ends on", () => {
	it("reports empty when every round the run paid for matched nothing", () => {
		expect(terminalStatus("short", 0, 3, 3)).toBe("empty");
	});

	it("keeps exhausted when only some rounds matched nothing", () => {
		expect(terminalStatus("exhausted", 0, 1, 3)).toBe("exhausted");
	});

	it("never reports empty for a run that found a company", () => {
		expect(terminalStatus("short", 1, 1, 1)).toBe("short");
	});

	it("leaves a run that never started a round alone", () => {
		expect(terminalStatus("capped", 0, 0, 0)).toBe("capped");
	});
});
