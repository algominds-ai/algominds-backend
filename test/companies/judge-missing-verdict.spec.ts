import { describe, expect, it } from "vitest";
import type { CompanyRow } from "@/core/companies/gate";
import { decideRows } from "@/core/companies/judge";
import { requirementFixture } from "../support/icp";

const recordRequirement = requirementFixture("the company is a bank");

const row: CompanyRow = {
	name: "a.com",
	domain: "a.com",
	linkedinUrl: "https://linkedin.com/company/a",
	record: null,
	description: null,
};

describe("a row the judge never scored is never stored", () => {
	it("refuses a row with no verdict, even when every hard requirement is a plain record one", () => {
		const decision = decideRows({
			requirements: [recordRequirement],
			rows: [row],
			verdicts: [],
			excluded: new Set(),
		});

		expect(decision.stored).toHaveLength(0);
		expect(decision.rejects[0]?.reason).toBe(
			"the judge produced no verdict for this row",
		);
	});
});
