import { expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import { runOneCompany } from "@/workflows/find-people-company";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";
import { fakePeopleVendors } from "../support/people";
import { fakeWorkflowStep } from "../support/step";
import {
	bareCompany,
	cleanupPeopleRun,
	evidenceRowsFor,
	runCompanyRowsFor,
	seedPeopleRun,
} from "./support";

async function context() {
	const seed = await seedPeopleRun("grouping-failure");
	const ctx = {
		env: fakeModelEnv(
			{},
			fakeSecretEnv({ EXA_API_KEY: "test", CLAY_API_KEY: "test" }),
		),
		step: fakeWorkflowStep().step,
		runId: seed.runId,
		organizationId: seed.org.id,
		buyer: resolveBuyer({ target: "Founder/CEO", profile: null }),
	};
	const roster = [0, 1].map((id) => ({
		name: `Person ${id}`,
		title: "Founder",
		company: "Example",
		url: `https://linkedin.com/in/person-${id}`,
		location: null,
		since: null,
	}));
	const vendors = fakePeopleVendors(roster);
	return { seed, ctx, vendors };
}

it("counts every unprocessed candidate when the grouping purchase fails", async () => {
	const originalFetch = globalThis.fetch;
	const { seed, ctx, vendors } = await context();
	try {
		globalThis.fetch = async (input, init) =>
			String(input).endsWith("/chat/completions")
				? Response.json(
						{
							error: { message: "Unavailable", type: "invalid_request_error" },
						},
						{ status: 400 },
					)
				: vendors.fetch(input, init);
		const result = await runOneCompany(
			ctx,
			{
				...bareCompany("example.com"),
				name: "Example",
				exaId: "exact-employer",
			},
			0,
		);
		expect(result.outcome.capped).toBe(true);
		const [stored] = await runCompanyRowsFor(ctx.runId);
		const evidence = await evidenceRowsFor(stored?.id ?? "");
		const counts = evidence.find((row) => row.kind === "completeness");
		expect(JSON.parse(counts?.value ?? "{}")).toMatchObject({
			eligible: 2,
			checked: 0,
			unprocessed: 2,
			capped: true,
		});
	} finally {
		globalThis.fetch = originalFetch;
		await cleanupPeopleRun(seed);
	}
});
