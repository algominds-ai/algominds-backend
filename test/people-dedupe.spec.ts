import { describe, expect, it } from "vitest";
import { dedupe, nameKey } from "../src/core/people/dedupe";

describe("name key", () => {
	it("strips credential suffixes so a name matches its credentialed form", () => {
		expect(nameKey("Mary Hart, MHA")).toBe(nameKey("MHA Mary Hart"));
		expect(nameKey("Mary Hart, MHA")).toBe("mary|hart");
	});

	it("strips diacritics so an accented name matches its plain form", () => {
		expect(nameKey("José Núñez")).toBe("jose|nunez");
	});
});

describe("dedupe", () => {
	it("merges duplicate rows by canonical url then name key", () => {
		const rows = [
			{
				name: "Mary Hart",
				title: null,
				company: null,
				url: null,
				location: null,
				since: null,
				source: "clay:head",
			},
			{
				name: "Mary Hart, MHA",
				title: "Head of Compliance",
				company: "Harbor Robotics",
				url: "https://www.linkedin.com/in/maryhart/",
				location: "Austin, Texas",
				since: "2021-01-01",
				source: "clay:c-suite",
			},
		];

		const result = dedupe(rows);

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe(0);
		expect(result[0]?.seenBy.sort()).toEqual(["clay:c-suite", "clay:head"]);
		expect(result[0]?.url).toBe("https://linkedin.com/in/maryhart");
		expect(result[0]?.name).toBe("Mary Hart, MHA");
	});

	it("merges www and bare linkedin urls for the same profile", () => {
		const rows = [
			{
				name: "Devon Ashworth",
				title: "CRO",
				company: "Harbor Robotics",
				url: "https://www.linkedin.com/in/x/",
				location: null,
				since: null,
				source: "clay:c-suite",
			},
			{
				name: "Devon Ashworth",
				title: "CRO",
				company: "Harbor Robotics",
				url: "linkedin.com/in/x",
				location: null,
				since: null,
				source: "clay:vp",
			},
		];

		const result = dedupe(rows);

		expect(result).toHaveLength(1);
		expect(result[0]?.seenBy.sort()).toEqual(["clay:c-suite", "clay:vp"]);
	});

	it("assigns ids as positions in the merged list", () => {
		const rows = [
			{
				name: "Alice Alpha",
				title: "CEO",
				company: "Acme",
				url: null,
				location: null,
				since: null,
				source: "clay:founder",
			},
			{
				name: "Bob Beta",
				title: "CFO",
				company: "Acme",
				url: null,
				location: null,
				since: null,
				source: "clay:c-suite",
			},
		];

		const result = dedupe(rows);

		expect(result.map((r) => r.id)).toEqual([0, 1]);
	});
});

describe("dedupe: a confirmed url settles what a name key cannot", () => {
	it("keeps two same-named people apart when each carries its own, different canonical url", () => {
		const rows = [
			{
				name: "Mary Hart",
				title: "Head of Compliance",
				company: "Harbor Robotics",
				url: "https://linkedin.com/in/mary-hart-1",
				location: null,
				since: null,
				source: "clay:head",
			},
			{
				name: "Mary Hart",
				title: "Head of Compliance",
				company: "Harbor Robotics",
				url: "https://linkedin.com/in/mary-hart-2",
				location: null,
				since: null,
				source: "clay:c-suite",
			},
		];

		const result = dedupe(rows);

		expect(result).toHaveLength(2);
		expect(result.map((r) => r.url).sort()).toEqual([
			"https://linkedin.com/in/mary-hart-1",
			"https://linkedin.com/in/mary-hart-2",
		]);
	});

	it("registers a row's canonical url once a name merge fills it in, so a later differently-spelled name still lands on the same person", () => {
		const rows = [
			{
				name: "Mary Hart",
				title: null,
				company: null,
				url: null,
				location: null,
				since: null,
				source: "clay:head",
			},
			{
				name: "Mary Hart",
				title: "Head of Compliance",
				company: "Harbor Robotics",
				url: "https://linkedin.com/in/maryhart",
				location: null,
				since: null,
				source: "clay:c-suite",
			},
			{
				name: "M. Hart",
				title: "Head of Compliance",
				company: "Harbor Robotics",
				url: "https://www.linkedin.com/in/maryhart/",
				location: null,
				since: null,
				source: "clay:vp",
			},
		];

		const result = dedupe(rows);

		expect(result).toHaveLength(1);
		expect(result[0]?.seenBy.sort()).toEqual([
			"clay:c-suite",
			"clay:head",
			"clay:vp",
		]);
	});

	it("drops a row with a canonical url but no name, since no name can be contacted or verified", () => {
		const rows = [
			{
				name: null,
				title: "Head of Compliance",
				company: "Harbor Robotics",
				url: "https://linkedin.com/in/anonymous",
				location: null,
				since: null,
				source: "clay:head",
			},
		];

		expect(dedupe(rows)).toHaveLength(0);
	});
});
