import { describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import {
	type RequirementEvidence,
	supportedStatus,
} from "@/core/companies/judge-evidence";
import { conditionRefs } from "@/core/requirements";

const source = "https://acme.com/careers/platform";
const requirements = [
	{
		kind: "required" as const,
		anyOf: [
			{
				allOf: [
					{
						text: "posted a platform role",
						window: {
							amount: 30,
							unit: "days" as const,
							appliesTo: "publication" as const,
							direction: "past" as const,
						},
						sourceRule: "company website",
					},
				],
			},
		],
	},
];
const id = conditionRefs(requirements)[0]?.id ?? "r1.a1.c1";
const row: CompanyRow = {
	name: "Acme",
	domain: "acme.com",
	linkedinUrl: null,
	record: null,
	description: null,
};
const page = (
	text: string,
	publishedDate: string | null,
): ReadonlyMap<string, RequirementEvidence> =>
	new Map([[source, { url: source, text, quote: "", publishedDate }]]);
const cases = [
	{
		name: "nonexistent cited source",
		evidence: page("posted a platform role", "2026-09-01"),
		sourceUrl: "https://acme.com/missing",
		date: "2026-09-01",
		expected: "unproven",
	},
	{
		name: "absent page",
		evidence: new Map<string, RequirementEvidence>(),
		sourceUrl: source,
		date: "2026-09-01",
		expected: "unproven",
	},
	{
		name: "out of window",
		evidence: page("posted a platform role", "2026-01-01"),
		sourceUrl: source,
		date: "2026-01-01",
		expected: "unproven",
	},
	{
		name: "missing date",
		evidence: page("posted a platform role", null),
		sourceUrl: source,
		date: null,
		expected: "unproven",
	},
	{
		name: "exact dated evidence",
		evidence: page("posted a platform role", "2026-09-01T00:00:00.000Z"),
		sourceUrl: source,
		date: null,
		expected: "proven",
	},
];

describe("supported status requires grounded evidence", () => {
	it.each(cases)("returns $expected for $name", ({
		evidence,
		sourceUrl: citedSource = source,
		date,
		expected,
	}) => {
		expect(
			supportedStatus(
				{ id, status: "proven", sourceUrl: citedSource, date },
				row,
				requirements,
				{ evidence, today: "2026-09-06" },
			).status,
		).toBe(expected);
	});
});
