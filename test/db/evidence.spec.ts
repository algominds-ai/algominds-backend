import { env as testEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withConnection } from "@/core/db/client";
import type { Organization } from "@/core/db/queries";
import { appendEvidence, latestEvidence } from "@/core/db/queries";
import { saveRunCompanies } from "@/core/db/run-companies";
import type { NewEvidence } from "@/core/db/schema";
import { evidence } from "@/core/db/schema";
import { rawEvidenceRow } from "@/core/people/rows";
import { seedOrganization, seedRunFor, wipeOrganizations } from "../support/db";

type EvidenceFixture = { org: Organization; runCompanyId: string };

async function seedRunCompanyEvidence(label: string): Promise<EvidenceFixture> {
	const org = await seedOrganization(label);
	const opened = await seedRunFor(org, "people");
	const [row] = await saveRunCompanies(testEnv, [
		{
			runId: opened.id,
			domain: `${label}-${crypto.randomUUID()}.com`,
			companyId: null,
			identity: "domain",
			mode: "profile",
			buyerSource: "captured",
		},
	]);
	if (!row) throw new Error("seed failed to save a run_company row");
	return { org, runCompanyId: row.id };
}

describe("appendEvidence and latestEvidence", () => {
	it("never resolves a conflict, so a retried write leaves every row it wrote", async () => {
		const fixture = await seedRunCompanyEvidence("evidence-append");
		const row: NewEvidence = {
			subjectType: "run_company",
			subjectId: fixture.runCompanyId,
			kind: "verify-1-poll-1",
			value: "unknown",
			source: "exa",
		};

		try {
			await appendEvidence(testEnv, [row]);
			await appendEvidence(testEnv, [row]);

			const rows = await withConnection(testEnv, "direct", db, (c) =>
				c
					.select()
					.from(evidence)
					.where(eq(evidence.subjectId, fixture.runCompanyId)),
			);
			expect(rows).toHaveLength(2);
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});

	it("orders by seen_at descending and returns the newest row", async () => {
		const fixture = await seedRunCompanyEvidence("evidence-latest");
		const older = new Date("2026-01-01T00:00:00.000Z");
		const newer = new Date("2026-01-02T00:00:00.000Z");

		try {
			await appendEvidence(testEnv, [
				{
					subjectType: "run_company",
					subjectId: fixture.runCompanyId,
					kind: "email",
					value: "old@acme.com",
					source: "apollo",
					seenAt: older,
				},
				{
					subjectType: "run_company",
					subjectId: fixture.runCompanyId,
					kind: "email",
					value: "new@acme.com",
					source: "apollo",
					seenAt: newer,
				},
			]);

			const result = await latestEvidence(
				testEnv,
				fixture.runCompanyId,
				"email",
			);

			expect(result?.value).toBe("new@acme.com");
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});
});

describe("rawEvidenceRow", () => {
	it("stores a raw string reply and a parsed JSON reply, both on the requested-domain subject", async () => {
		const fixture = await seedRunCompanyEvidence("evidence-raw");
		const verdictBody = {
			verdict: "CONTRADICTED",
			evidence_url: null,
			evidence_quote: null,
			evidence_kind: null,
			confidence: 0.4,
		};

		try {
			await appendEvidence(testEnv, [
				rawEvidenceRow(
					fixture.runCompanyId,
					"identity-create",
					"clay",
					'{"search_id":"abc-123"}',
				),
				rawEvidenceRow(
					fixture.runCompanyId,
					"verify-1-poll-1",
					"exa",
					verdictBody,
				),
			]);

			const rows = await withConnection(testEnv, "direct", db, (c) =>
				c
					.select()
					.from(evidence)
					.where(eq(evidence.subjectId, fixture.runCompanyId)),
			);

			expect(rows.find((r) => r.kind === "identity-create")?.value).toBe(
				'{"search_id":"abc-123"}',
			);
			const verdictRow = rows.find((r) => r.kind === "verify-1-poll-1");
			expect(verdictRow ? JSON.parse(verdictRow.value) : null).toEqual(
				verdictBody,
			);
			expect(rows.every((r) => r.subjectType === "run_company")).toBe(true);
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});
});
