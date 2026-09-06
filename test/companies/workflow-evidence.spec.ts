import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FindCompaniesResult } from "@/core/companies";
import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import { organization } from "@/core/db/auth-schema";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import { createIcp } from "@/core/db/queries";
import {
	company as companyTable,
	evidence as evidenceTable,
	icp as icpTable,
	run,
} from "@/core/db/schema";
import { profileFixture, requirementFixture } from "../support/icp";

const storedRequirements = [requirementFixture("the company fits the profile")];

async function seedRun(
	label: string,
): Promise<{ organizationId: string; icpId: string }> {
	const org = await organizationForSlug(
		testEnv,
		`companies-evidence-${label}-${crypto.randomUUID()}`,
		label,
	);
	const domain = `${label}-${crypto.randomUUID()}.internal`;
	const icpRow = await createIcp(testEnv, {
		domain,
		organizationId: org.id,
		doc: profileFixture(
			{ requirements: storedRequirements },
			`seed profile for the ${label} test`,
			domain,
		),
	});
	return { organizationId: org.id, icpId: icpRow.id };
}

async function cleanup(seed: {
	organizationId: string;
	icpId: string;
	instanceId: string;
}): Promise<void> {
	await withConnection(testEnv, "direct", db, async (connection) => {
		await connection
			.delete(evidenceTable)
			.where(eq(evidenceTable.subjectId, seed.instanceId));
		await connection
			.delete(companyTable)
			.where(eq(companyTable.runId, seed.instanceId));
		await connection.delete(run).where(eq(run.id, seed.instanceId));
		await connection.delete(icpTable).where(eq(icpTable.id, seed.icpId));
		await connection
			.delete(organization)
			.where(eq(organization.id, seed.organizationId));
	});
}

async function savedCompanyIds(runId: string): Promise<string[]> {
	const saved = await withConnection(testEnv, "direct", db, (connection) =>
		connection.select().from(companyTable).where(eq(companyTable.runId, runId)),
	);
	return saved.map((row) => row.id);
}

async function evidenceKinds(subjectIds: string[]): Promise<string[]> {
	const rows = await withConnection(testEnv, "direct", db, (connection) =>
		connection
			.select()
			.from(evidenceTable)
			.where(inArray(evidenceTable.subjectId, subjectIds)),
	);
	return rows.map((row) => row.kind);
}

function companyRow(domain: string, quote: string | null): CompanyRow {
	return {
		name: `Co ${domain}`,
		domain,
		linkedinUrl: null,
		evidenceUrl: `https://${domain}`,
		evidenceQuote: quote,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: quote ? "hiring a founding engineer" : null,
		evidenceDate: quote ? "2026-08-20" : null,
	};
}

function captureFor(domain: string, withPages: boolean): CompanyCapture {
	return {
		entity: {
			name: domain,
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
			id: null,
			url: `https://${domain}/`,
			title: domain,
			signal: null,
			quote: null,
			publisher: null,
			kind: null,
			publishedDate: null,
			score: null,
			evidenceCheck: withPages ? "found" : null,
			fitReason: null,
		},
		raw: JSON.stringify({ url: `https://${domain}/` }),
		source: withPages ? "exa-agent" : "exa-search",
	};
}

function roundResultFor(
	domains: string[],
	withPages: boolean,
): FindCompaniesResult {
	const quote = (domain: string) =>
		withPages ? `${domain} is hiring now.` : null;
	return {
		companies: domains.map((domain) => companyRow(domain, quote(domain))),
		requested: domains.length,
		found: domains.length,
		rounds: 1,
		status: "complete",
		costDollars: 0.05,
		rejects: [],
		searches: [],
		captures: Object.fromEntries(
			domains.map((domain) => [domain, captureFor(domain, withPages)]),
		),
		seenDomains: domains,
		feedback: [],
		pages: withPages
			? domains.map((domain) => ({
					domain,
					url: `https://${domain}/careers`,
					text: `${domain} is hiring now.`,
				}))
			: [],
	};
}

describe("what the workflow persists as evidence", () => {
	it("stores one search-result evidence row per kept company, carrying the vendor's own result", async () => {
		const seed = await seedRun("raw-evidence");
		const domain = `raw-evidence-co-${crypto.randomUUID()}.example`;
		const instanceId = `companies_raw_evidence_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "round_1" },
					roundResultFor([domain], false),
				);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 1 },
			});
			await instance.waitForStatus("complete");

			const ids = await savedCompanyIds(instanceId);
			expect(ids).toHaveLength(1);
			const kinds = await evidenceKinds(ids);
			expect(kinds.filter((kind) => kind === "search-result")).toHaveLength(1);
		} finally {
			await instance.dispose();
			await cleanup({ ...seed, instanceId });
		}
	});

	it("stores one proving-page evidence row for each of a dozen quoted companies from one agent round", async () => {
		const seed = await seedRun("proving-pages");
		const domains = Array.from(
			{ length: 12 },
			(_, i) => `proving-${i}-${crypto.randomUUID()}.example`,
		);
		const instanceId = `companies_proving_pages_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.FIND_COMPANIES,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await m.mockStepResult(
					{ name: "round_1" },
					roundResultFor(domains, true),
				);
			});
			await testEnv.FIND_COMPANIES.create({
				id: instanceId,
				params: { icpId: seed.icpId, count: 12 },
			});
			await instance.waitForStatus("complete");

			const ids = await savedCompanyIds(instanceId);
			expect(ids).toHaveLength(12);
			const kinds = await evidenceKinds(ids);
			expect(kinds.filter((kind) => kind === "proving-page")).toHaveLength(12);
		} finally {
			await instance.dispose();
			await cleanup({ ...seed, instanceId });
		}
	});
});
