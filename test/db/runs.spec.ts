import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withConnection } from "@/core/db/client";
import { organizationForSlug } from "@/core/db/organizations";
import {
	closeErroredRun,
	closeRun,
	createIcp,
	loadIcp,
	openRun,
	organizationSpendToday,
	recordRunSpend,
	saveRound,
} from "@/core/db/queries";
import { round, run } from "@/core/db/schema";
import type { IcpSeller } from "@/core/synthesize";
import { seedOrganization, seedRunFor, wipeOrganizations } from "../support/db";

describe("organizationForSlug and openRun: idempotent creation", () => {
	it("returns the existing organization rather than creating a second one for the same slug", async () => {
		const slug = `runs-org-${crypto.randomUUID()}.internal`;
		const first = await organizationForSlug(testEnv, slug, "Acme");

		try {
			const second = await organizationForSlug(testEnv, slug, "Acme");
			expect(second.id).toBe(first.id);
		} finally {
			await wipeOrganizations([first.id]);
		}
	});

	it("returns the run already opened under this id when a retried step re-inserts it", async () => {
		const org = await seedOrganization("runs-open");
		const newRun = {
			id: `companies_${crypto.randomUUID()}`,
			organizationId: org.id,
			icpId: null,
			capability: "companies",
			status: "running",
		};

		try {
			const first = await openRun(testEnv, newRun);
			const second = await openRun(testEnv, newRun);

			expect(second.id).toBe(first.id);
			expect(second.startedAt).toEqual(first.startedAt);
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});

describe("recordRunSpend and closeRun: the run lifecycle", () => {
	it("records spend mid-run without ending it, then records the terminal status, spend and finish time", async () => {
		const org = await seedOrganization("runs-lifecycle");
		const opened = await seedRunFor(org, "companies", { status: "running" });

		try {
			await recordRunSpend(testEnv, opened.id, 1.25);
			const [midRun] = await withConnection(testEnv, "direct", db, (c) =>
				c.select().from(run).where(eq(run.id, opened.id)),
			);
			expect(midRun?.costDollars).toBe(1.25);
			expect(midRun?.status).toBe("running");
			expect(midRun?.finishedAt).toBeNull();

			await closeRun(testEnv, opened.id, {
				status: "complete",
				costDollars: 4.5,
			});
			const [closed] = await withConnection(testEnv, "direct", db, (c) =>
				c.select().from(run).where(eq(run.id, opened.id)),
			);
			expect(closed?.status).toBe("complete");
			expect(closed?.costDollars).toBe(4.5);
			expect(closed?.finishedAt).toBeInstanceOf(Date);
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});

describe("closeErroredRun", () => {
	it("closes an opened run as errored while keeping its banked spend, and no-ops for a run never opened", async () => {
		const org = await seedOrganization("runs-error");
		const opened = await seedRunFor(org, "people", { status: "running" });

		try {
			await recordRunSpend(testEnv, opened.id, 2.5);
			await closeErroredRun(testEnv, opened.id);
			const [stored] = await withConnection(testEnv, "direct", db, (c) =>
				c.select().from(run).where(eq(run.id, opened.id)),
			);
			expect(stored?.status).toBe("errored");
			expect(stored?.costDollars).toBe(2.5);

			await expect(
				closeErroredRun(testEnv, `missing-${crypto.randomUUID()}`),
			).resolves.toBeUndefined();
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});

describe("organizationSpendToday", () => {
	it("sums only this organization's runs since midnight UTC", async () => {
		const org = await seedOrganization("runs-spend-today");
		const otherOrg = await seedOrganization("runs-spend-today-other");
		const runA = await seedRunFor(org, "companies", { status: "running" });
		const runB = await seedRunFor(org, "companies", { status: "running" });
		const otherRun = await seedRunFor(otherOrg, "companies", {
			status: "running",
		});

		try {
			await recordRunSpend(testEnv, runA.id, 1.5);
			await recordRunSpend(testEnv, runB.id, 2.25);
			await recordRunSpend(testEnv, otherRun.id, 100);

			const total = await organizationSpendToday(testEnv, org.id);

			expect(total).toBe(3.75);
		} finally {
			await wipeOrganizations([org.id, otherOrg.id]);
		}
	});
});

describe("saveRound", () => {
	it("stores the plan, counts and reject reasons, and a replayed write never doubles the row", async () => {
		const org = await seedOrganization("runs-round");
		const opened = await seedRunFor(org, "companies", { status: "running" });
		const payload = {
			runId: opened.id,
			ordinal: 1,
			plan: { query: "payment platforms" },
			found: 1,
			rejected: { filter: 1, gate: 0, judge: 1 },
			rejects: [
				{
					domain: "a.com",
					reason: "evidence is 369 days old",
					stage: "filter",
				},
			],
		};

		try {
			await saveRound(testEnv, payload);
			await saveRound(testEnv, payload);

			const rows = await withConnection(testEnv, "cached", db, (c) =>
				c.select().from(round).where(eq(round.runId, opened.id)),
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.plan).toEqual(payload.plan);
			expect(rows[0]?.rejects).toEqual(payload.rejects);
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});

describe("createIcp and loadIcp", () => {
	it("stores the whole document, reads it back, and defaults an omitted seller, buyer and requirements to null", async () => {
		const org = await seedOrganization("runs-icp-create");
		const seller: IcpSeller = {
			domain: "acme.com",
			customers: ["Acme Corp"],
			competitorTest: "A competitor sells the same tooling to other vendors.",
		};

		try {
			const withSeller = await createIcp(testEnv, {
				domain: "acme.com",
				organizationId: org.id,
				description: "an ideal customer profile",
				seller,
			});
			expect(withSeller.doc).toEqual({
				description: "an ideal customer profile",
				seller,
				buyer: null,
				requirements: null,
			});
			const reloaded = await loadIcp(testEnv, withSeller.id);
			expect(reloaded?.doc).toEqual(withSeller.doc);

			const withoutSeller = await createIcp(testEnv, {
				domain: "acme.com",
				organizationId: org.id,
				description: "a prompt-only profile",
			});
			expect(withoutSeller.doc).toEqual({
				description: "a prompt-only profile",
				seller: null,
				buyer: null,
				requirements: null,
			});
		} finally {
			await wipeOrganizations([org.id]);
		}
	});
});
