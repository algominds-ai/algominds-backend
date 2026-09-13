import { afterEach, expect, it } from "vitest";
import { findRun, upsertPeople } from "@/core/db/queries";
import { resolveBuyer } from "@/core/people/buyer";
import { PersonDataSchema } from "@/core/people/rows";
import { runOneCompany } from "@/workflows/find-people-company";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";
import { fakePeopleVendors } from "../support/people";
import { fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	cleanupPeopleRun,
	evidenceRowsFor,
	personRowsFor,
	type SeededPeopleRun,
	seedPeopleRun,
} from "./support";

const seeds: SeededPeopleRun[] = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const seed of seeds) await cleanupPeopleRun(seed);
	seeds.length = 0;
});
const company = {
	...bareCompany("example.com"),
	name: "Example",
	exaId: "exact",
};
const rows = [0, 1, 2].map((id) => ({
	name: `Person ${id}`,
	title: "Founder",
	company: "Example",
	url: `https://linkedin.com/in/person-${id}`,
	location: null,
	since: null,
}));

async function context(label: string) {
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

it("searches each selected person and sends only unresolved people to Agent", async () => {
	const ctx = await context("search-routing");
	const vendors = fakePeopleVendors(rows, {
		searchUnresolvedIds: [2],
		searchRejectedIds: [1],
	});
	const agentIds: number[][] = [];
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/agent/runs"))
			agentIds.push(
				JSON.parse(String(init?.body)).input.data.map(
					(row: { id: number }) => row.id,
				),
			);
		return vendors.fetch(input, init);
	};
	const result = await runOneCompany(ctx, company, 0);
	expect(agentIds).toEqual([[2]]);
	expect(vendors.calls.filter((url) => url.endsWith("/search"))).toHaveLength(
		3,
	);
	expect(result.outcome).toMatchObject({
		verified: 2,
		roster: 0,
		capped: false,
	});
	expect(result.costDollars).toBeCloseTo(0.137);
	expect((await findRun(ctx.env, ctx.runId))?.costDollars).toBeCloseTo(
		result.costDollars,
	);
});

it("retains unresolved people with a pending status and explanation", async () => {
	const ctx = await context("search-pending");
	globalThis.fetch = fakePeopleVendors(rows.slice(0, 1), {
		searchUnresolvedIds: [0],
		agentUnresolvedIds: [0],
	}).fetch;
	const result = await runOneCompany(ctx, company, 0);
	const [person] = await personRowsFor(ctx.organizationId);
	expect(result.outcome).toMatchObject({
		verified: 0,
		roster: 1,
		capped: false,
	});
	expect(person?.data).toMatchObject({
		status: "pending",
		basis: expect.any(String),
	});
	expect(
		(await evidenceRowsFor(person?.id ?? "")).some(
			(row) => row.kind === "verify-agent",
		),
	).toBe(true);
	if (!person) throw new Error("Missing pending person");
	const [verified] = await upsertPeople(ctx.env, [
		{
			...person,
			data: { ...PersonDataSchema.parse(person.data), status: "verified" },
		},
	]);
	await upsertPeople(ctx.env, [person]);
	expect((await personRowsFor(ctx.organizationId))[0]?.data).toEqual(
		verified?.data,
	);
});

it("banks an unreadable paid Search response and falls back without repeating Search", async () => {
	const ctx = await context("search-malformed");
	const vendors = fakePeopleVendors(rows.slice(0, 1));
	let searches = 0;
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/search")) {
			searches++;
			return Response.json({
				requestId: "broken",
				costDollars: { total: 0.012 },
				results: "bad",
			});
		}
		return vendors.fetch(input, init);
	};
	const result = await runOneCompany(ctx, company, 0);
	expect(searches).toBe(1);
	expect(result.outcome.verified).toBe(1);
	expect(result.costDollars).toBeCloseTo(0.112);
});
