import { describe, expect, it } from "vitest";
import { type DedupeRow, dedupe } from "@/core/people/dedupe";

const row: DedupeRow = {
	name: "Alex Doe",
	title: "CTO",
	company: "Example",
	url: "https://www.linkedin.com/in/alex",
	location: null,
	since: null,
	source: "clay:c-suite",
};

describe("people roster identity", () => {
	it("unions canonical profiles and combined roles without merging namesakes", () => {
		const result = dedupe([
			row,
			{
				...row,
				url: "https://linkedin.com/in/alex/",
				title: "Co-founder",
				source: "clay:founder",
			},
			{ ...row, url: "https://linkedin.com/in/another-alex" },
		]);
		expect(result).toHaveLength(2);
		expect(result[0]?.seenBy).toEqual(["clay:c-suite", "clay:founder"]);
		expect(result[0]?.title).toBe("CTO; Co-founder");
	});
	it("retains a named candidate needing profile research and rejects a fabricated host", () => {
		const result = dedupe([
			{ ...row, url: null },
			{ ...row, url: "https://linkedin.com.evil.test/in/alex" },
			{ ...row, name: null },
		]);
		expect(result).toHaveLength(2);
		expect(result.every((person) => person.url === null)).toBe(true);
	});
});
