import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DbFactory } from "@/core/db/queries";
import { saveRunCompanies } from "@/core/db/run-companies";
import type {
	CompanyPageConnection,
	CompanyPageRow,
	RunCompanyPageRow,
} from "@/core/db/run-pages";
import { companiesPage, peoplePage } from "@/core/db/run-pages";
import type { Company } from "@/core/db/schema";
import {
	linkRunCompany,
	seedCompanyFor,
	seedIcpFor,
	seedOrganization,
	seedPersonFor,
	seedRunFor,
	wipeOrganizations,
} from "../support/db";
import { fakeDbEnv } from "../support/env";
import {
	companyRow,
	rosterPersonData,
	runRow,
	verifiedPersonData,
} from "../support/rows";

function recordingCompanyPageDb(
	rows: Company[],
): DbFactory<CompanyPageConnection> {
	return () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({ limit: () => Promise.resolve(rows) }),
				}),
			}),
		}),
	});
}

function isRunCompanyPageRow(row: CompanyPageRow): row is RunCompanyPageRow {
	return "runId" in row && "identity" in row;
}

function pageOf(limit: number): { limit: number; cursor: undefined } {
	return { limit, cursor: undefined };
}

describe("companiesPage: cursor stability", () => {
	it("reports the last row's id as the next cursor only when a row is left over", async () => {
		const run = runRow({
			id: "run-1",
			capability: "companies",
			status: "complete",
		});

		const withExtra = await companiesPage(
			fakeDbEnv("x", "y"),
			run,
			pageOf(2),
			recordingCompanyPageDb([
				companyRow("c1"),
				companyRow("c2"),
				companyRow("c3"),
			]),
		);
		const withoutExtra = await companiesPage(
			fakeDbEnv("x", "y"),
			run,
			pageOf(2),
			recordingCompanyPageDb([companyRow("c1"), companyRow("c2")]),
		);

		expect(withExtra.rows.map((row) => row.id)).toEqual(["c1", "c2"]);
		expect(withExtra.nextCursor).toBe("c2");
		expect(withoutExtra.nextCursor).toBeNull();
	});
});

describe("companiesPage: an unresolved requested domain", () => {
	it("keeps a people run's unresolved requested domain on the page, with no company", async () => {
		const org = await seedOrganization("pages-unresolved");
		const peopleRun = await seedRunFor(org, "people");
		const domain = `unresolved-${crypto.randomUUID()}.example`;
		await saveRunCompanies(testEnv, [
			{
				runId: peopleRun.id,
				domain,
				companyId: null,
				identity: "unresolved",
				mode: "roster",
				buyerSource: "none",
			},
		]);

		try {
			const page = await companiesPage(testEnv, peopleRun, pageOf(5));
			const [row] = page.rows;
			if (!row || !isRunCompanyPageRow(row)) {
				throw new Error("expected a run_company page row");
			}
			expect(row.domain).toBe(domain);
			expect(row.companyId).toBeNull();
			expect(row.company).toBeNull();
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});

describe("peoplePage: a run type with no companies", () => {
	it("hands back an empty page", async () => {
		const page = await peoplePage(
			testEnv,
			runRow({ id: "onboarding_x", capability: "onboarding", icpId: null }),
			pageOf(5),
		);

		expect(page).toEqual({ rows: [], nextCursor: null });
	});
});

describe("peoplePage: scoped to one companies run", () => {
	it("never returns a sibling companies run's person", async () => {
		const org = await seedOrganization("pages-companies-scope");
		const icpRow = await seedIcpFor(org, "pages-companies-scope");
		const ownRun = await seedRunFor(org, "companies", { icpId: icpRow.id });
		const otherRun = await seedRunFor(org, "companies", { icpId: icpRow.id });
		const ownCompany = await seedCompanyFor(org, ownRun, "own", {
			icpId: icpRow.id,
		});
		const otherCompany = await seedCompanyFor(org, otherRun, "other", {
			icpId: icpRow.id,
		});
		await seedPersonFor(org, ownCompany, "Own Person");
		await seedPersonFor(org, otherCompany, "Other Person");

		try {
			const page = await peoplePage(testEnv, ownRun, pageOf(5));
			expect(page.rows.map((row) => row.companyId)).toEqual([ownCompany.id]);
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});

describe("peoplePage: a profileless people run", () => {
	it("scopes through its resolved run_company rows, never another organization's", async () => {
		const org = await seedOrganization("pages-profileless");
		const otherOrg = await seedOrganization("pages-profileless-other");
		const companiesRun = await seedRunFor(org, "companies");
		const peopleRun = await seedRunFor(org, "people");
		const ownCompany = await seedCompanyFor(org, companiesRun, "profileless");
		const otherCompany = await seedCompanyFor(
			otherOrg,
			companiesRun,
			"profileless-other",
		);
		await linkRunCompany(peopleRun, ownCompany, "roster", "none");
		await seedPersonFor(org, ownCompany, "Own Person", rosterPersonData());
		await seedPersonFor(
			otherOrg,
			otherCompany,
			"Other Person",
			rosterPersonData(),
		);

		try {
			const page = await peoplePage(testEnv, peopleRun, pageOf(10));
			expect(page.rows.map((row) => row.name)).toEqual(["Own Person"]);
		} finally {
			await wipeOrganizations([org.id, otherOrg.id]);
		}
	});
});

describe("peoplePage: only the statuses a run's mode stores", () => {
	it("shows target mode just verified, and roster mode both roster and verified", async () => {
		const org = await seedOrganization("pages-stored-status");
		const targetRun = await seedRunFor(org, "people");
		const rosterRun = await seedRunFor(org, "people");
		const savedCompany = await seedCompanyFor(org, targetRun, "stored-status");
		await linkRunCompany(targetRun, savedCompany, "target", "target");
		await linkRunCompany(rosterRun, savedCompany, "roster", "none");
		await seedPersonFor(org, savedCompany, "Roster Person", rosterPersonData());
		await seedPersonFor(
			org,
			savedCompany,
			"Verified Person",
			verifiedPersonData({ seenBy: ["exa"] }),
		);

		try {
			const targetPage = await peoplePage(testEnv, targetRun, pageOf(10));
			const rosterPage = await peoplePage(testEnv, rosterRun, pageOf(10));

			expect(targetPage.rows.map((row) => row.name)).toEqual([
				"Verified Person",
			]);
			expect(rosterPage.rows.map((row) => row.name).sort()).toEqual([
				"Roster Person",
				"Verified Person",
			]);
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});
