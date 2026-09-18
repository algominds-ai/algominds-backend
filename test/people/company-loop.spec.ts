import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/config";
import { CostLedger } from "@/core/cost";
import { findRun, saveRunCompanies } from "@/core/db/queries";
import { resolveBuyer } from "@/core/people/buyer";
import {
	type CompanyLoopContext,
	type CompanyProgress,
	runCompanies,
	runOneCompany,
} from "@/workflows/find-people-company";
import { buyPeopleStep } from "@/workflows/find-people-spend";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";
import { fakePeopleVendors } from "../support/people";
import { fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	cleanupPeopleRun,
	evidenceRowsFor,
	personRowsFor,
	runCompanyRowsFor,
	type SeededPeopleRun,
	seedPeopleRun,
} from "./support";

const originalFetch = globalThis.fetch;
const seeds: SeededPeopleRun[] = [];
afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const seed of seeds) await cleanupPeopleRun(seed);
	seeds.length = 0;
});

async function context(label: string): Promise<CompanyLoopContext> {
	const seed = await seedPeopleRun(label);
	seeds.push(seed);
	return {
		env: fakeModelEnv(
			{},
			fakeSecretEnv({ EXA_API_KEY: "test", CLAY_API_KEY: "test" }),
		),
		step: fakeWorkflowStep().step,
		runId: seed.runId,
		organizationId: seed.org.id,
		buyer: resolveBuyer({ target: "Founder/CEO", profile: null }),
	};
}
const company = {
	...bareCompany("example.com"),
	name: "Example",
	exaId: "exact-employer",
};
const rows = [
	{
		name: "Alex Doe",
		title: "Founder",
		company: "Example",
		url: "https://linkedin.com/in/alex",
		location: null,
		since: null,
	},
];

describe("people company flow", () => {
	it("persists Search's corrected title and evidence without starting an agent", async () => {
		const ctx = await context("sources");
		const vendors = fakePeopleVendors(rows, {
			correctedTitle: "Founder and CEO",
		});
		globalThis.fetch = vendors.fetch;
		const result = await runOneCompany(ctx, company, 0);
		expect(result.outcome).toMatchObject({ verified: 1, capped: false });
		const [person] = await personRowsFor(ctx.organizationId);
		expect(person?.title).toBe("Founder and CEO");
		expect(person?.linkedinUrl).toBe("https://linkedin.com/in/alex");
		const evidence = await evidenceRowsFor(person?.id ?? "");
		expect(
			evidence.some(
				(row) =>
					row.kind === "verify-search" &&
					row.source === "exa" &&
					row.value.includes('"decision":"verified"'),
			),
		).toBe(true);
		expect(
			vendors.calls.filter((url) => url.endsWith("/agent/runs")),
		).toHaveLength(0);
		expect(
			vendors.calls.filter((url) => url.endsWith("/chat/completions")),
		).toHaveLength(0);
		expect(vendors.calls.some((url) => url.endsWith("/contents"))).toBe(false);
	});
	it("retrieves a company roster without seniority or title filters", async () => {
		const ctx = await context("unfiltered");
		const vendors = fakePeopleVendors(rows);
		let rosterRequest: unknown;
		globalThis.fetch = async (input, init) => {
			if (String(input).endsWith("/search/filters-mode"))
				rosterRequest = JSON.parse(String(init?.body));
			return vendors.fetch(input, init);
		};
		await runOneCompany(ctx, company, 0);
		expect(rosterRequest).toEqual({
			source_type: "people",
			filters: { company_identifier: ["example.com"] },
		});
		expect(
			vendors.calls.filter((url) => url.endsWith("/search/filters-mode")),
		).toHaveLength(1);
	});
});

it("researches ICP bands separately and retains every small-roster candidate", async () => {
	const ctx = await context("grouped");
	const roster = ["Founder", "VP", "Founder", "VP"].map((title, id) => ({
		name: `Person ${id}`,
		title,
		company: "Example",
		url: `https://linkedin.com/in/person-${id}`,
		location: null,
		since: null,
	}));
	const vendors = fakePeopleVendors(roster, {
		filterRejectedIds: [0],
		searchUnresolvedIds: [0, 1, 2, 3],
	});
	const batches: number[][] = [];
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/agent/runs")) {
			const request = JSON.parse(String(init?.body));
			batches.push(request.input.data.map((row: { id: number }) => row.id));
		}
		return vendors.fetch(input, init);
	};
	const result = await runOneCompany(ctx, company, 0);
	expect(batches).toEqual([
		[0, 2],
		[1, 3],
	]);
	expect(result.outcome).toMatchObject({ verified: 4, capped: false });
	expect(await personRowsFor(ctx.organizationId)).toHaveLength(4);
});

describe("people partial results", () => {
	it("retains valid research output and caps a batch with missing subjects", async () => {
		const ctx = await context("missing");
		globalThis.fetch = fakePeopleVendors(
			[
				...rows,
				{
					...rows[0],
					name: "Other Person",
					title: "CEO",
					company: "Example",
					url: "https://linkedin.com/in/other",
					location: null,
					since: null,
				},
			],
			{ omittedIds: [1], searchUnresolvedIds: [1] },
		).fetch;
		const result = await runOneCompany(ctx, company, 0);
		expect(result.outcome.verified).toBe(1);
		expect(result.outcome.capped).toBe(true);
		const [stored] = await runCompanyRowsFor(ctx.runId);
		expect(
			(await evidenceRowsFor(stored?.id ?? "")).some(
				(row) =>
					row.kind.includes("coverage") && row.value.includes('"missing":[1]'),
			),
		).toBe(true);
	});
	it("runs one fallback for an empty company roster and reports no invented people", async () => {
		const ctx = await context("fallback");
		const vendors = fakePeopleVendors([], {
			emptyClay: true,
		});
		globalThis.fetch = vendors.fetch;
		const result = await runOneCompany(ctx, company, 0);
		expect(vendors.calls.filter((url) => url.endsWith("/search"))).toHaveLength(
			1,
		);
		expect(result.outcome.verified).toBe(0);
		expect(result.outcome.capped).toBe(false);
	});
});

describe("people company settlement", () => {
	it("cancels a timed-out medium run and retains its fee before surfacing incomplete work", async () => {
		const ctx = await context("settle");
		const vendors = fakePeopleVendors(rows, {
			pending: true,
			searchUnresolvedIds: [0],
		});
		globalThis.fetch = vendors.fetch;
		const result = await runOneCompany(ctx, company, 0);
		expect(result.outcome.capped).toBe(true);
		expect(result.costDollars).toBeCloseTo(0.042);
		expect(vendors.calls.some((url) => url.endsWith("/cancel"))).toBe(true);
		expect((await findRun(testEnv, ctx.runId))?.costDollars).toBeCloseTo(
			result.costDollars,
		);
	});
	it("errors an unbilled settlement and retains its nonzero reservation evidence", async () => {
		const ctx = await context("unknown-bill");
		globalThis.fetch = fakePeopleVendors(rows, {
			pending: true,
			unknownBill: true,
			searchUnresolvedIds: [0],
		}).fetch;
		await expect(runOneCompany(ctx, company, 0)).rejects.toThrow(
			"billing remains unknown",
		);
		const [stored] = await runCompanyRowsFor(ctx.runId);
		expect(
			(await evidenceRowsFor(stored?.id ?? "")).some((row) =>
				row.value.includes('"reservedDollars":0.1'),
			),
		).toBe(true);
	});
	it("stops admitting companies at the existing spend ceiling", async () => {
		const ctx = await context("ceiling");
		const vendors = fakePeopleVendors(rows);
		globalThis.fetch = vendors.fetch;
		const { perRunDollars } = config.spend;
		const result = await runCompanies(ctx, [company], perRunDollars);
		expect(result.companiesSearched).toBe(0);
		expect(result.capped).toBe(true);
		expect(vendors.calls).toHaveLength(0);
	});
});

async function progressFor(ctx: CompanyLoopContext): Promise<CompanyProgress> {
	const [row] = await saveRunCompanies(ctx.env, [
		{
			runId: ctx.runId,
			domain: company.domain,
			companyId: null,
			identity: null,
			mode: "target",
			buyerSource: "target",
		},
	]);
	if (!row) throw new Error("Missing company run");
	return {
		company,
		companyId: "",
		runCompanyId: row.id,
		spentSoFar: 0,
		ledger: new CostLedger(),
		clayRecords: 0,
		discovered: 0,
		eligible: 0,
		researched: 0,
		checked: 0,
		verified: 0,
		roster: 0,
		capped: false,
		billingUnknown: false,
		unresolved: false,
		contextResolved: false,
	};
}

it("banks a failed purchase's reported fee and error before surfacing the failure", async () => {
	const ctx = await context("partial-cost");
	const progress = await progressFor(ctx);
	await expect(
		buyPeopleStep(ctx, progress, "partial", async (ledger) => {
			ledger.reported("exa", "contents", 0.017);
			throw new Error("Output unreadable");
		}),
	).rejects.toThrow("Output unreadable");
	expect((await findRun(testEnv, ctx.runId))?.costDollars).toBeCloseTo(0.017);
	const evidence = await evidenceRowsFor(progress.runCompanyId);
	expect(
		evidence.some(
			(row) =>
				row.value.includes('"costDollars":0.017') &&
				row.value.includes("Output unreadable"),
		),
	).toBe(true);
});

it("researches every plausible buyer beyond the old first-twenty-five limit", async () => {
	const ctx = await context("large-roster");
	const roster = Array.from({ length: 30 }, (_, id) => ({
		name: `Person ${id}`,
		title: "Founder",
		company: "Example",
		url: `https://linkedin.com/in/person-${id}`,
		location: null,
		since: null,
	}));
	const vendors = fakePeopleVendors(roster);
	globalThis.fetch = vendors.fetch;
	const result = await runOneCompany(ctx, company, 0);
	expect(result.outcome).toMatchObject({ verified: 30, capped: false });
	expect(
		vendors.calls.filter((url) => url.endsWith("/agent/runs")),
	).toHaveLength(0);
	expect(
		vendors.calls.filter((url) => url.endsWith("/chat/completions")),
	).toHaveLength(1);
	expect(vendors.calls.some((url) => url.endsWith("/contents"))).toBe(false);
	expect(await personRowsFor(ctx.organizationId)).toHaveLength(30);
});
