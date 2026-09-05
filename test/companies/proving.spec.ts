import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import {
	proveRows,
	provingDemand,
	verifyEvidenceRows,
} from "@/core/companies/proof";
import { CostLedger } from "@/core/cost";
import type { Requirement } from "@/core/requirements";
import { fakeSecretEnv } from "../support/env";
import { exaContentsFetch } from "../support/fetch";

function countingFetch(inner: typeof fetch): {
	fetch: typeof fetch;
	calls: number;
} {
	const counter = { fetch: inner, calls: 0 };
	counter.fetch = (input, init) => {
		counter.calls += 1;
		return inner(input, init);
	};
	return counter;
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

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("verifyEvidenceRows batches every checkable row into one exaContents call", () => {
	it("sends one request for two rows citing different pages, never one per row", async () => {
		const counting = countingFetch(
			exaContentsFetch({
				"https://a.example/careers": { text: "A Co is hiring now." },
				"https://b.example/careers": { text: "B Co is hiring now." },
			}),
		);
		globalThis.fetch = counting.fetch;
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

		const result = await verifyEvidenceRows(
			rows,
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(counting.calls).toBe(1);
		expect(result.kept.map((r) => r.domain)).toEqual([
			"a.example",
			"b.example",
		]);
	});

	it("dedupes the url list when two rows cite the same page", async () => {
		globalThis.fetch = exaContentsFetch({
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

		const result = await verifyEvidenceRows(
			rows,
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(result.kept).toHaveLength(2);
		expect(result.checks["shared-alice.example"]).toBe("found");
		expect(result.checks["shared-bob.example"]).toBe("found");
	});

	it("never calls exaContents when every row is missing its url or quote", async () => {
		globalThis.fetch = async () => {
			throw new Error("no fetch should run when nothing needs checking");
		};
		const rows = [row({ domain: "silent.example" })];

		const result = await verifyEvidenceRows(
			rows,
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(result.kept).toHaveLength(0);
		expect(result.rejects).toEqual([
			{ index: 0, reason: "missing-required", detail: null },
		]);
	});
});

describe("verifyEvidenceRows tells a truly missing page from one merely absent from the reply", () => {
	it("treats a url the vendor's reply never mentions as an error and keeps no page for it", async () => {
		globalThis.fetch = exaContentsFetch({
			"https://ghost.example/careers": { absent: true },
		});
		const rows = [
			row({
				domain: "ghost.example",
				evidenceUrl: "https://ghost.example/careers",
				evidenceQuote: "Ghost Co is hiring now.",
			}),
		];

		const result = await verifyEvidenceRows(
			rows,
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(result.kept).toHaveLength(1);
		expect(result.checks["ghost.example"]).toBe("CRAWL_ABSENT_FROM_REPLY");
		expect(result.pages).toEqual([]);
	});

	it("rejects a row whose page truly does not exist, keeping the rest of the batch", async () => {
		globalThis.fetch = exaContentsFetch({
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

		const result = await verifyEvidenceRows(
			rows,
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(result.kept.map((r) => r.domain)).toEqual(["good.example"]);
		expect(result.rejects).toEqual([
			{ index: 1, reason: "evidence-not-on-page", detail: "CRAWL_NOT_FOUND" },
		]);
	});
});

describe("verifyEvidenceRows keeps the page it crawled as evidence", () => {
	it("keeps the crawled page as evidence for every row whose quote it checked", async () => {
		globalThis.fetch = exaContentsFetch({
			"https://a.example/careers": { text: "A Co is hiring now." },
			"https://b.example/careers": { text: "Nothing about hiring here." },
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

		const result = await verifyEvidenceRows(
			rows,
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(result.pages).toEqual([
			{
				domain: "a.example",
				url: "https://a.example/careers",
				text: "A Co is hiring now.",
			},
			{
				domain: "b.example",
				url: "https://b.example/careers",
				text: "Nothing about hiring here.",
			},
		]);
	});
});

describe("verifyEvidenceRows bounds one exaContents call to a handful of urls", () => {
	it("splits a dozen urls into concurrent calls of the configured batch size, never one huge request", async () => {
		const batchSize = config.companies.provingConcurrency;
		const rows = Array.from({ length: batchSize * 2 + 2 }, (_, i) =>
			row({
				domain: `co${i}.example`,
				evidenceUrl: `https://co${i}.example/careers`,
				evidenceQuote: `Co ${i} is hiring now.`,
			}),
		);
		const byUrl = Object.fromEntries(
			rows.map((_r, i) => [
				`https://co${i}.example/careers`,
				{ text: `Co ${i} is hiring now.` },
			]),
		);
		const counting = countingFetch(exaContentsFetch(byUrl));
		globalThis.fetch = counting.fetch;

		const result = await verifyEvidenceRows(
			rows,
			fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }),
			new CostLedger(),
		);

		expect(counting.calls).toBe(3);
		expect(result.kept).toHaveLength(rows.length);
		expect(Object.keys(result.checks)).toHaveLength(rows.length);
	});
});

const windowed: Requirement = {
	id: "r5",
	text: "runs production Kubernetes",
	kind: "hard",
	proof: "page",
	windowDays: 730,
};

describe("a proving search is bounded by the requirement's window", () => {
	it("dates the earliest acceptable page at today less the window, and leaves an unwindowed requirement unbounded", () => {
		expect(provingDemand(windowed, "2026-09-03").notBefore).toBe("2024-09-03");
		expect(
			provingDemand({ ...windowed, windowDays: null }, "2026-09-03").notBefore,
		).toBeNull();
	});

	it("sends the window as startPublishedDate on every proving search", async () => {
		const bodies: string[] = [];
		globalThis.fetch = async (_input, init) => {
			bodies.push(String(init?.body));
			return new Response(JSON.stringify({ requestId: "r", results: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const env = fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });

		await proveRows(
			[row({ domain: "bank.com", name: "Bank" })],
			provingDemand(windowed, "2026-09-03"),
			env,
			new CostLedger(),
		);

		expect(bodies.length).toBeGreaterThan(0);
		for (const body of bodies) {
			expect(JSON.parse(body).startPublishedDate).toBe("2024-09-03");
		}
	});
});
