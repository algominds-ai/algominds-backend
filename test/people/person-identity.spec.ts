import { describe, expect, it } from "vitest";
import type { CandidateIdentity } from "@/core/people/person-identity";
import { groupByPersonIdentity } from "@/core/people/person-identity";

function candidate(
	name: string,
	title: string,
	url: string | null,
): CandidateIdentity {
	return { name, title, url };
}

describe("groupByPersonIdentity", () => {
	it("groups the same person's three LinkedIn URL variants under one canonical group", () => {
		const tiffanyA = candidate(
			"Tiffany Masse",
			"Regional Operations Manager",
			"https://linkedin.com/in/tiffany-masse-968691358",
		);
		const tiffanyB = candidate(
			"Tiffany Masse",
			"Regional Operations Manager",
			"https://linkedin.com/in/tiffany-masse-3610a1375",
		);
		const tiffanyC = candidate(
			"Tiffany Masse",
			"Regional Operations Manager",
			"https://linkedin.com/in/tiffany-masse-96b17036",
		);

		const groups = groupByPersonIdentity(
			[tiffanyA, tiffanyB, tiffanyC],
			(item) => item,
			"peakdentalservices.com",
		);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.canonical).toBe(tiffanyA);
		expect(groups[0]?.duplicates).toEqual([tiffanyB, tiffanyC]);
	});

	it("keeps two people with the same name but different titles apart", () => {
		const operations = candidate(
			"Jordan Blake",
			"Regional Operations Manager",
			"https://linkedin.com/in/jordan-blake-ops",
		);
		const sales = candidate(
			"Jordan Blake",
			"VP Sales",
			"https://linkedin.com/in/jordan-blake-sales",
		);

		const groups = groupByPersonIdentity(
			[operations, sales],
			(item) => item,
			"example.com",
		);

		expect(groups).toHaveLength(2);
	});

	it("merges the exact same canonical LinkedIn URL seen twice", () => {
		const first = candidate(
			"Casey Doe",
			"Director Sales",
			"https://www.linkedin.com/in/casey-doe/",
		);
		const second = candidate(
			"Casey Doe",
			"Director Sales",
			"https://linkedin.com/in/casey-doe",
		);

		const groups = groupByPersonIdentity(
			[first, second],
			(item) => item,
			"example.com",
		);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.duplicates).toEqual([second]);
	});

	it("does not merge on name alone when neither url nor title matches", () => {
		const withTitle = candidate(
			"Alex Rivera",
			"CFO",
			"https://linkedin.com/in/alex-rivera-cfo",
		);
		const withoutTitle = candidate("Alex Rivera", "", null);

		const groups = groupByPersonIdentity(
			[withTitle, withoutTitle],
			(item) => item,
			"example.com",
		);

		expect(groups).toHaveLength(2);
	});
});
