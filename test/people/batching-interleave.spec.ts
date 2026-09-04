import { describe, expect, it } from "vitest";
import { runCompanies } from "@/workflows/find-people-company";
import { eventIndex, orderedContext } from "./ordered-step";
import {
	bareCompany,
	cleanupPeopleRun,
	runCompanyRowsFor,
	seedPeopleRun,
} from "./support";

type InterleaveCompany = {
	domain: string;
	name: string;
	clayRecords: number;
	rosterDollars: number;
	candidate: { name: string; url: string };
};

function batchInterleaveOverrides(
	company: InterleaveCompany,
): [string, unknown][] {
	const { domain, name, clayRecords, rosterDollars, candidate } = company;
	return [
		[
			`people-${domain}-identity`,
			{
				how: "domain",
				identifier: domain,
				name,
				clayRecords,
				costEntries: [{ provider: "clay", op: "search", dollars: 0.02 }],
			},
		],
		[
			`people-${domain}-roster`,
			{
				candidates: [
					{
						...candidate,
						id: 0,
						title: "VP Marketing",
						company: name,
						location: null,
						since: null,
						seenBy: ["clay"],
					},
				],
				clayRecords,
				costEntries: [
					{ provider: "clay", op: "search", dollars: rosterDollars },
				],
			},
		],
	];
}

function interleavePair(
	domainA: string,
	domainB: string,
): Map<string, unknown> {
	return new Map<string, unknown>([
		...batchInterleaveOverrides({
			domain: domainA,
			name: "Batch Co A",
			clayRecords: 2,
			rosterDollars: 0.03,
			candidate: {
				name: "Avery A",
				url: "https://linkedin.com/in/avery-a-batch",
			},
		}),
		...batchInterleaveOverrides({
			domain: domainB,
			name: "Batch Co B",
			clayRecords: 4,
			rosterDollars: 0.05,
			candidate: {
				name: "Blair B",
				url: "https://linkedin.com/in/blair-b-batch",
			},
		}),
	]);
}

describe("runCompanies: two companies sharing a batch", () => {
	it("keeps its own run_company row, roster count, and banked spend for each company", async () => {
		const domainA = `batch-interleave-a-${crypto.randomUUID()}.example`;
		const domainB = `batch-interleave-b-${crypto.randomUUID()}.example`;
		const seed = await seedPeopleRun("batch-interleave");
		try {
			const overrides = interleavePair(domainA, domainB);
			const events: string[] = [];

			const result = await runCompanies(
				orderedContext(seed.runId, seed.org.id, overrides, events),
				[bareCompany(domainA), bareCompany(domainB)],
				0,
			);

			expect(result.companiesSearched).toBe(2);
			expect(result.peopleRoster).toBe(2);
			expect(eventIndex(events, `start:people-${domainB}-open`)).toBeLessThan(
				eventIndex(events, `end:people-${domainA}-spend`),
			);

			const runCompanyRows = await runCompanyRowsFor(seed.runId);
			const rowA = runCompanyRows.find((row) => row.domain === domainA);
			const rowB = runCompanyRows.find((row) => row.domain === domainB);
			if (!rowA || !rowB) throw new Error("expected one row per domain");
			expect(rowA.spendDollars).toBeCloseTo(0.05);
			expect(rowB.spendDollars).toBeCloseTo(0.07);
		} finally {
			await cleanupPeopleRun(seed);
		}
	});
});
