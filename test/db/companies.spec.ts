import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DbMode } from "@/core/db/client";
import { db, withConnection } from "@/core/db/client";
import type {
	CompanyInsertConnection,
	DbFactory,
	DomainsConnection,
} from "@/core/db/queries";
import {
	companiesForRun,
	recentDomains,
	saveCompanies,
} from "@/core/db/queries";
import type {
	CompanyCreateConnection,
	CompanyRunConnection,
	RunCompanyInsertConnection,
	RunCompanyLookupConnection,
} from "@/core/db/run-companies";
import { createCompanyRow, saveRunCompanies } from "@/core/db/run-companies";
import { company } from "@/core/db/schema";
import {
	linkRunCompany,
	seedCompanyFor,
	seedIcpFor,
	seedOrganization,
	seedRunFor,
	wipeOrganizations,
} from "../support/db";
import { fakeDbEnv } from "../support/env";
import { companyRow, runCompanyRow, runRow } from "../support/rows";

function conflictThenSelect<TRow>(existing: TRow[]) {
	return {
		insert: () => ({
			values: () => ({
				onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
			}),
		}),
		select: () => ({
			from: () => ({ where: () => Promise.resolve(existing) }),
		}),
	};
}

const requestedDomainRow = {
	runId: "run-1",
	domain: "acme.com",
	companyId: null,
	identity: null,
	mode: "roster",
	buyerSource: "none",
};

describe("recentDomains", () => {
	it("reads through the direct binding, never cached", async () => {
		let recordedMode: DbMode | undefined;
		const buildDb: DbFactory<DomainsConnection> = (_env, mode) => {
			recordedMode = mode;
			return {
				select: () => ({
					from: () => ({
						where: () => ({ orderBy: () => Promise.resolve([]) }),
					}),
				}),
			};
		};

		await recentDomains(fakeDbEnv("x", "y"), "org-1", buildDb);

		expect(recordedMode).toBe("direct");
	});

	it("returns every company for the account, but not another account", async () => {
		const org = await seedOrganization("companies-recent");
		const otherOrg = await seedOrganization("companies-recent-other");
		const icpRow = await seedIcpFor(org, "companies-recent");
		const runA = await seedRunFor(org, "companies", { icpId: icpRow.id });
		const otherRun = await seedRunFor(otherOrg, "companies");
		const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const stale = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

		try {
			const kept = await seedCompanyFor(org, runA, "recent-kept", {
				icpId: icpRow.id,
				foundAt: recent,
			});
			const staleRow = await seedCompanyFor(org, runA, "recent-stale", {
				icpId: icpRow.id,
				foundAt: stale,
			});
			await seedCompanyFor(otherOrg, otherRun, "recent-other", {
				foundAt: recent,
			});

			const result = await recentDomains(testEnv, org.id);

			expect(result).toEqual([kept.domain, staleRow.domain]);
		} finally {
			await wipeOrganizations([org.id, otherOrg.id]);
		}
	});
});

describe("saveCompanies", () => {
	it("normalizes the domain before the unique (icp_id, domain) insert, so a re-saved company is a no-op", async () => {
		const org = await seedOrganization("companies-save");
		const icpRow = await seedIcpFor(org, "companies-save");
		const opened = await seedRunFor(org, "companies", { icpId: icpRow.id });
		const domain = `save-${crypto.randomUUID()}.com`;

		try {
			const [saved] = await saveCompanies(testEnv, [
				{
					icpId: icpRow.id,
					organizationId: org.id,
					domain: `https://WWW.${domain.toUpperCase()}/careers`,
					name: "Acme",
					runId: opened.id,
				},
			]);
			if (!saved) throw new Error("seed failed to save a company");
			expect(saved.domain).toBe(domain);

			const repeat = await saveCompanies(testEnv, [
				{
					icpId: icpRow.id,
					organizationId: org.id,
					domain,
					name: "Acme Again",
					runId: opened.id,
				},
			]);
			expect(repeat).toEqual([]);

			const rows = await withConnection(testEnv, "direct", db, (c) =>
				c.select().from(company).where(eq(company.icpId, icpRow.id)),
			);
			expect(rows).toHaveLength(1);
		} finally {
			await wipeOrganizations([org.id]);
		}
	});

	it("returns early without opening a connection for an empty batch", async () => {
		let called = false;
		const buildDb: DbFactory<CompanyInsertConnection> = () => {
			called = true;
			throw new Error("must not run for an empty batch");
		};

		const result = await saveCompanies(fakeDbEnv("x", "y"), [], buildDb);

		expect(result).toEqual([]);
		expect(called).toBe(false);
	});
});

describe("createCompanyRow", () => {
	it("re-selects a concurrently inserted row through the direct binding, never cached", async () => {
		const existing = companyRow("company-1");
		const modes: DbMode[] = [];
		const buildDb: DbFactory<CompanyCreateConnection> = (_env, mode) => {
			modes.push(mode);
			return conflictThenSelect([existing]);
		};

		const result = await createCompanyRow(
			fakeDbEnv("x", "y"),
			{
				organizationId: "org-1",
				domain: "acme.com",
				name: "Acme",
				icpId: null,
				runId: "run-1",
			},
			buildDb,
		);

		expect(result.id).toBe(existing.id);
		expect(modes).toEqual(["cached", "direct"]);
	});
});

describe("saveRunCompanies: the conflict fallback", () => {
	it("re-selects a domain the run already recorded through the direct binding, instead of treating the conflict as a miss", async () => {
		const existing = runCompanyRow("run-company-1");
		const modes: DbMode[] = [];
		const buildDb: DbFactory<
			RunCompanyInsertConnection & RunCompanyLookupConnection
		> = (_env, mode) => {
			modes.push(mode);
			return conflictThenSelect([existing]);
		};

		const [result] = await saveRunCompanies(
			fakeDbEnv("x", "y"),
			[requestedDomainRow],
			buildDb,
		);

		expect(result).toEqual(existing);
		expect(modes).toEqual(["cached", "direct"]);
	});

	it("throws when the fallback select also finds nothing", async () => {
		const buildDb: DbFactory<
			RunCompanyInsertConnection & RunCompanyLookupConnection
		> = () => conflictThenSelect([]);

		await expect(
			saveRunCompanies(fakeDbEnv("x", "y"), [requestedDomainRow], buildDb),
		).rejects.toThrow(/no row found/);
	});
});

describe("companiesForRun", () => {
	it("filters by run id, orders by found_at then id, and reads the saved Exa id off data when present", async () => {
		const rows = [
			{
				id: "c1",
				domain: "acme.com",
				name: "Acme",
				description: null,
				linkedinUrl: "https://linkedin.com/company/acme",
				icpId: "icp-1",
				data: { provider: "exa-search", result: { id: "exa-org-1" } },
			},
		];
		const buildDb: DbFactory<CompanyRunConnection> = () => ({
			select: () => ({
				from: () => ({
					where: () => ({ orderBy: () => Promise.resolve(rows) }),
				}),
			}),
		});

		const result = await companiesForRun(
			fakeDbEnv("x", "y"),
			runRow({ id: "run-1", capability: "companies", status: "complete" }),
			buildDb,
		);

		expect(result[0]?.exaId).toBe("exa-org-1");
	});

	it("resolves a people run's companies through its resolved run rows, not by run id", async () => {
		const org = await seedOrganization("companies-people-run");
		const companiesRun = await seedRunFor(org, "companies");
		const peopleRun = await seedRunFor(org, "people");
		const linked = await seedCompanyFor(org, companiesRun, "linked");
		await seedCompanyFor(org, companiesRun, "unlinked");
		await linkRunCompany(peopleRun, linked, "roster", "none");

		try {
			const result = await companiesForRun(testEnv, peopleRun);
			expect(result.map((row) => row.id)).toEqual([linked.id]);
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});
