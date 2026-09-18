import { afterEach, expect, it } from "vitest";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { identifyCompanyRows } from "@/core/companies/identity";
import { decideRows, judge } from "@/core/companies/judge";
import { toNewCompany } from "@/core/companies/rows";
import { companyIdentityEvidence } from "../support/companies";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse, fakeGateway } from "../support/fetch";
import { requirementFixture } from "../support/icp";

const requirements = [requirementFixture("the company is an MSP")];
const company: CompanyRow = {
	name: "Acme",
	domain: "acme.com",
	linkedinUrl: null,
	record: null,
	description: null,
};
const sourceUrl = "https://acme.com/managed-it";
const reason = "Acme operates managed IT services for business clients.";
const fit = {
	index: 0,
	statuses: [
		{ id: "r1.a1.c1", status: "proven" as const, sourceUrl, date: null },
	],
	reason,
};
const capture: CompanyCapture = {
	entity: {
		name: "Acme",
		description: null,
		industry: null,
		foundedYear: null,
		workforceTotal: null,
		city: null,
		country: null,
		revenueAnnual: null,
		fundingTotal: null,
	},
	result: {
		id: "https://exa.ai/library/organization/acme",
		url: "https://acme.com/",
		title: "Acme",
		qualification: fit,
	},
	evidence: [],
	raw: "{}",
	source: "exa-search",
};
const pages = new Map([
	...(companyIdentityEvidence([company]).get(0) ?? []),
	[sourceUrl, { url: sourceUrl, quote: "", text: reason }],
]);
const context = { icpId: "icp-1", runId: "run-1", organizationId: "org-1" };
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

it("persists the upstream company identity after an ICP-only verdict", async () => {
	const identified = identifyCompanyRows([company], new Map([[0, pages]]));
	globalThis.fetch = fakeGateway([
		chatCompletionResponse({ content: JSON.stringify({ verdicts: [fit] }) }),
	]).fetch;
	const result = await judge(requirements, identified.rows, fakeGatewayEnv(), {
		evidenceByRow: identified.evidenceByRow,
	});
	expect(result.verdicts).toEqual([fit]);
	const decision = decideRows({
		requirements,
		rows: identified.rows,
		verdicts: result.verdicts,
		excluded: new Set(),
	});
	const accepted = decision.stored[0];
	expect(accepted).toBeDefined();
	if (!accepted) throw new Error("expected the proven company");
	expect(toNewCompany(accepted, context, capture)).toMatchObject({
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: "https://www.linkedin.com/company/acme.com",
		selectionReason: reason,
	});
	expect(company.linkedinUrl).toBeNull();
});
