import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { verifyEvidenceRows } from "../src/core/companies/evidence";
import type { CompanyRow } from "../src/core/companies/gate";
import { CostLedger } from "../src/core/cost";

function exaEnv(): Env {
	return { ...testEnv, EXA_API_KEY: { get: async () => "test-exa-key" } };
}

function row(overrides: Partial<CompanyRow> & { domain: string }): CompanyRow {
	return {
		name: null,
		linkedinUrl: null,
		evidenceUrl: null,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: null,
		evidenceDate: null,
		...overrides,
	};
}

const ContentsRequestSchema = z.object({ urls: z.array(z.string()) });

type FetchCapture = { calls: number; urls: string[][] };

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubContents(
	byUrl: Record<string, { text: string } | { errorTag: string }>,
): FetchCapture {
	const capture: FetchCapture = { calls: 0, urls: [] };
	globalThis.fetch = async (_input, init) => {
		capture.calls += 1;
		const { urls } = ContentsRequestSchema.parse(
			JSON.parse(String(init?.body)),
		);
		capture.urls.push(urls);
		const results: { url: string; text: string }[] = [];
		const statuses: (
			| { id: string; status: "success" }
			| { id: string; status: "error"; error: { tag: string } }
		)[] = [];
		for (const url of urls) {
			const outcome = byUrl[url];
			if (!outcome) continue;
			if ("errorTag" in outcome) {
				statuses.push({
					id: url,
					status: "error",
					error: { tag: outcome.errorTag },
				});
				continue;
			}
			statuses.push({ id: url, status: "success" });
			results.push({ url, text: outcome.text });
		}
		return jsonResponse(200, {
			requestId: "req-contents",
			results,
			statuses,
			costDollars: { total: 0.003 },
		});
	};
	return capture;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("verifyEvidenceRows batches every checkable row into one exaContents call", () => {
	it("sends one request for two rows citing different pages, never one per row", async () => {
		const capture = stubContents({
			"https://a.example/careers": { text: "A Co is hiring now." },
			"https://b.example/careers": { text: "B Co is hiring now." },
		});
		const rows = [
			row({
				domain: "a.example",
				evidenceUrl: "https://a.example/careers",
				evidenceQuote: "A Co is hiring now.",
			}),
			row({
				domain: "b.example",
				evidenceUrl: "https://b.example/careers",
				evidenceQuote: "B Co is hiring now.",
			}),
		];

		const result = await verifyEvidenceRows(rows, exaEnv(), new CostLedger());

		expect(capture.calls).toBe(1);
		expect(result.kept.map((r) => r.domain)).toEqual([
			"a.example",
			"b.example",
		]);
	});

	it("dedupes the url list when two rows cite the same page", async () => {
		const capture = stubContents({
			"https://shared.example/about": {
				text: "Alice runs sales. Bob runs ops.",
			},
		});
		const rows = [
			row({
				domain: "shared-alice.example",
				evidenceUrl: "https://shared.example/about",
				evidenceQuote: "Alice runs sales.",
			}),
			row({
				domain: "shared-bob.example",
				evidenceUrl: "https://shared.example/about",
				evidenceQuote: "Bob runs ops.",
			}),
		];

		const result = await verifyEvidenceRows(rows, exaEnv(), new CostLedger());

		expect(capture.calls).toBe(1);
		expect(capture.urls[0]).toEqual(["https://shared.example/about"]);
		expect(result.kept).toHaveLength(2);
		expect(result.checks["shared-alice.example"]).toBe("found");
		expect(result.checks["shared-bob.example"]).toBe("found");
	});

	it("never calls exaContents when every row is missing its url or quote", async () => {
		globalThis.fetch = async () => {
			throw new Error("no fetch should run when nothing needs checking");
		};
		const rows = [row({ domain: "silent.example" })];

		const result = await verifyEvidenceRows(rows, exaEnv(), new CostLedger());

		expect(result.kept).toHaveLength(0);
		expect(result.rejects).toEqual([
			{ index: 0, reason: "missing-required", detail: null },
		]);
	});

	it("treats a url the vendor's reply never mentions as an error, never as found", async () => {
		stubContents({});
		const rows = [
			row({
				domain: "ghost.example",
				evidenceUrl: "https://ghost.example/careers",
				evidenceQuote: "Ghost Co is hiring now.",
			}),
		];

		const result = await verifyEvidenceRows(rows, exaEnv(), new CostLedger());

		expect(result.kept).toHaveLength(1);
		expect(result.checks["ghost.example"]).toBe("CRAWL_ABSENT_FROM_REPLY");
	});

	it("rejects a row whose page truly does not exist, keeping the rest of the batch", async () => {
		stubContents({
			"https://good.example/careers": { text: "Good Co is hiring now." },
			"https://missing.example/careers": { errorTag: "CRAWL_NOT_FOUND" },
		});
		const rows = [
			row({
				domain: "good.example",
				evidenceUrl: "https://good.example/careers",
				evidenceQuote: "Good Co is hiring now.",
			}),
			row({
				domain: "missing.example",
				evidenceUrl: "https://missing.example/careers",
				evidenceQuote: "Missing Co is hiring now.",
			}),
		];

		const result = await verifyEvidenceRows(rows, exaEnv(), new CostLedger());

		expect(result.kept.map((r) => r.domain)).toEqual(["good.example"]);
		expect(result.rejects).toEqual([
			{ index: 1, reason: "evidence-not-on-page", detail: "CRAWL_NOT_FOUND" },
		]);
	});
});
