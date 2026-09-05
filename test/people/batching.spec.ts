import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { config } from "@/config";
import { runCompanies } from "@/workflows/find-people-company";
import {
	eventIndex,
	orderedContext,
	rosterModeOverrides,
	unresolvedModeOverrides,
} from "./ordered-step";
import { bareCompany } from "./support";

function batchOrderOverrides(
	domains: string[],
	unresolvedIndexes: Set<number>,
): Map<string, unknown> {
	const overrides = new Map<string, unknown>();
	for (const [i, domain] of domains.entries()) {
		const pairs = unresolvedIndexes.has(i)
			? unresolvedModeOverrides(domain, i)
			: rosterModeOverrides(domain, i);
		for (const [name, value] of pairs) overrides.set(name, value);
		overrides.set(`people-${domain}-spend`, { total: 0 });
	}
	return overrides;
}

describe("runCompanies: batching by companyConcurrency", () => {
	it("runs twelve companies as three batches of five, overlapping within a batch but never across a batch boundary, and reports the summary in request order", async () => {
		const domains = Array.from(
			{ length: 12 },
			(_, i) => `batch-order-${i}.example`,
		);
		const overrides = batchOrderOverrides(domains, new Set([1, 3]));
		const events: string[] = [];

		const result = await runCompanies(
			orderedContext("batch-order-run", "org-1", overrides, events),
			domains.map(bareCompany),
			0,
		);

		expect(result.companiesSearched).toBe(12);
		expect(result.unknownDomains).toEqual([domains[1], domains[3]]);

		const firstBatchSpendEnds = domains
			.slice(0, 5)
			.map((domain) => eventIndex(events, `end:people-${domain}-spend`));
		const secondBatchStart = eventIndex(
			events,
			`start:people-${domains[5]}-open`,
		);
		expect(secondBatchStart).toBeGreaterThan(Math.max(...firstBatchSpendEnds));

		const secondCompanyOpenStart = eventIndex(
			events,
			`start:people-${domains[1]}-open`,
		);
		const firstCompanySpendEnd = eventIndex(
			events,
			`end:people-${domains[0]}-spend`,
		);
		expect(secondCompanyOpenStart).toBeLessThan(firstCompanySpendEnd);
	});
});

function batchCapOverrides(
	domains: string[],
	concurrency: number,
	perCompanySpend: number,
): Map<string, unknown> {
	const overrides = new Map<string, unknown>();
	for (const [i, domain] of domains.slice(0, concurrency).entries()) {
		for (const [name, value] of rosterModeOverrides(domain, i))
			overrides.set(name, value);
		overrides.set(`people-${domain}-spend`, { total: perCompanySpend });
	}
	overrides.set(
		`people-${domains[concurrency]}-open`,
		new NonRetryableError(
			"a run at the spend ceiling must never start the next batch",
		),
	);
	return overrides;
}

describe("runCompanies: the per-run spend ceiling checked between batches", () => {
	it("lets a batch already started finish, banks every one of its companies' spend, then caps before the next batch starts", async () => {
		const concurrency = config.people.companyConcurrency;
		const domains = Array.from(
			{ length: concurrency + 1 },
			(_, i) => `batch-cap-${i}.example`,
		);
		const perCompanySpend = (config.spend.perRunDollars / concurrency) * 1.5;
		const overrides = batchCapOverrides(domains, concurrency, perCompanySpend);
		const events: string[] = [];

		const result = await runCompanies(
			orderedContext("batch-cap-run", "org-1", overrides, events),
			domains.map(bareCompany),
			0,
		);

		expect(result.capped).toBe(true);
		expect(result.companiesSearched).toBe(concurrency);
		expect(result.costDollars).toBeCloseTo(concurrency * perCompanySpend);
		for (const domain of domains.slice(0, concurrency)) {
			eventIndex(events, `end:people-${domain}-spend`);
		}
		expect(events).not.toContain(`start:people-${domains[concurrency]}-open`);
	});
});
