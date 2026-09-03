import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CostLedger } from "../src/core/cost";
import {
	classifyVerdict,
	employerOpinion,
	indexOpinion,
	quoteOnPage,
} from "../src/core/people/verify";
import { getAgentVerdictRun } from "../src/core/providers/exa/agent";
import { RetryableProviderError } from "../src/core/providers/waterfall";
import verdictRun from "./fixtures/exa-agent-run-verdict.json";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function exaEnv(): Env {
	return { ...testEnv, EXA_API_KEY: { get: async () => "test-exa-key" } };
}

function modelEnv(): Env {
	return {
		...testEnv,
		AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
		CF_AIG_TOKEN: { get: async () => "test-aig-token" },
		MODEL_ROUTE_WORKER: "dynamic/brain-worker",
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function employerReply(employer: "SAME" | "DIFFERENT" | "UNKNOWN"): Response {
	const payload = {
		id: "chatcmpl-verify",
		model: "deepseek/deepseek-v4-flash-0731",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: JSON.stringify({ employer }) },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.000001 },
	};
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"cf-aig-model": "deepseek/deepseek-v4-flash-0731",
			"cf-aig-cache-status": "MISS",
		},
	});
}

const ContentsRequestSchema = z.object({ urls: z.array(z.string()) });

function contentsResponse(
	url: string,
	outcome: { text: string } | { errorTag: string },
): Response {
	const status =
		"errorTag" in outcome
			? { id: url, status: "error" as const, error: { tag: outcome.errorTag } }
			: { id: url, status: "success" as const };
	return jsonResponse(200, {
		requestId: "req-contents",
		results: "text" in outcome ? [{ url, text: outcome.text }] : [],
		statuses: [status],
		costDollars: { total: 0.003 },
	});
}

function personSearchResponse(): Response {
	return jsonResponse(200, {
		requestId: "req-index-1",
		costDollars: { total: 0.007 },
		results: [
			{
				id: "https://exa.ai/library/person/abc",
				url: "https://www.linkedin.com/in/janedoe",
				title: "Jane Doe",
				entities: [
					{
						id: "https://exa.ai/library/person/abc",
						type: "person",
						version: 1,
						properties: {
							name: "Jane Doe",
							firstName: "Jane",
							lastName: "Doe",
							location: null,
							workHistory: [
								{
									title: "VP of Sales",
									dates: { from: "2022-01-01", to: null },
									company: {
										id: "https://exa.ai/library/organization/xyz",
										name: "Acme Holdings",
									},
								},
							],
						},
					},
				],
			},
		],
	});
}

describe("verify: verdict classification", () => {
	it("accepts first-party confirmation with a present quote", async () => {
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.includes("/agent/runs/")) return jsonResponse(200, verdictRun);
			const { urls } = ContentsRequestSchema.parse(
				JSON.parse(String(init?.body)),
			);
			return contentsResponse(urls[0] ?? "", {
				text: "Leadership. Jane Doe is Acme's VP of Sales. Contact the team.",
			});
		};

		const run = await getAgentVerdictRun(
			verdictRun.id,
			exaEnv(),
			new CostLedger(),
		);
		if (run.status !== "completed") throw new Error("expected a completed run");

		expect(classifyVerdict(run.output)).toBe("verified");

		const outcome = await quoteOnPage(
			run.output.evidence_url ?? "",
			run.output.evidence_quote ?? "",
			exaEnv(),
			new CostLedger(),
		);
		expect(outcome).toEqual({ found: true, reason: "found" });
	});
});

describe("verify: aggregator evidence needs a second opinion", () => {
	it("requires a semantic second opinion for aggregator evidence", async () => {
		const verdict = {
			verdict: "CONFIRMED" as const,
			evidence_url: "https://somepeoplesite.example/jane-doe",
			evidence_quote: "Jane Doe — VP of Sales at Acme Holdings",
			evidence_kind: "aggregator" as const,
			confidence: 0.6,
		};
		expect(classifyVerdict(verdict)).toBe("needs_index");

		globalThis.fetch = async () => personSearchResponse();
		const index = await indexOpinion(
			{
				name: "Jane Doe",
				title: "VP of Sales",
				company: "Acme Inc",
				url: "https://linkedin.com/in/janedoe",
			},
			exaEnv(),
			new CostLedger(),
		);
		expect(index.found).toBe(true);
		expect(index.employer).toBe("Acme Holdings");

		globalThis.fetch = async () => employerReply("UNKNOWN");
		const unknownOpinion = await employerOpinion(
			{
				employer: index.employer ?? "",
				company: "Acme Inc",
				domain: "acme.com",
			},
			modelEnv(),
			new CostLedger(),
		);
		expect(unknownOpinion.label).toBe("UNKNOWN");

		globalThis.fetch = async () => employerReply("SAME");
		const sameOpinion = await employerOpinion(
			{
				employer: index.employer ?? "",
				company: "Acme Inc",
				domain: "acme.com",
			},
			modelEnv(),
			new CostLedger(),
		);
		expect(sameOpinion.label).toBe("SAME");
	});
});

describe("verify: the index match falls back from url to name key", () => {
	it("matches by name key when no url matches, and reports nothing found when neither matches", async () => {
		globalThis.fetch = async () => personSearchResponse();
		const byName = await indexOpinion(
			{
				name: "Jane Doe",
				title: "VP of Sales",
				company: "Acme Inc",
				url: "https://linkedin.com/in/someone-else",
			},
			exaEnv(),
			new CostLedger(),
		);
		expect(byName.found).toBe(true);
		expect(byName.employer).toBe("Acme Holdings");
		expect(byName.indexedTitle).toBe("VP of Sales");

		globalThis.fetch = async () => personSearchResponse();
		const noMatch = await indexOpinion(
			{
				name: "John Smith",
				title: "VP of Sales",
				company: "Acme Inc",
				url: "https://linkedin.com/in/someone-else",
			},
			exaEnv(),
			new CostLedger(),
		);
		expect(noMatch.found).toBe(false);
		expect(noMatch.employer).toBeNull();
		expect(noMatch.indexedTitle).toBeNull();
	});
});

describe("verify: the quote guard collapses whitespace before matching", () => {
	it("matches a quote across a line break Exa's crawl inserted", async () => {
		globalThis.fetch = async () =>
			contentsResponse("https://seccl.tech/blog/meet-the-secclers", {
				text: "This week, we're welcoming\nKristina Harris, our new growth director.",
			});
		expect(
			await quoteOnPage(
				"https://seccl.tech/blog/meet-the-secclers",
				"This week, we're welcoming Kristina Harris, our new growth director.",
				exaEnv(),
				new CostLedger(),
			),
		).toEqual({ found: true, reason: "found" });
	});

	it("still reports missing when the quote genuinely is not on the page", async () => {
		globalThis.fetch = async () =>
			contentsResponse("https://acme.com/team/jane-doe", {
				text: "Nothing about Jane Doe here.",
			});
		expect(
			await quoteOnPage(
				"https://acme.com/team/jane-doe",
				"Jane Doe is Acme's VP of Sales.",
				exaEnv(),
				new CostLedger(),
			),
		).toEqual({ found: false, reason: "missing" });
	});
});

describe("verify: the quote guard drops the URL rather than the verdict", () => {
	it("keeps a verdict but drops a URL Exa could not crawl at all", async () => {
		const verdict = {
			verdict: "CONFIRMED" as const,
			evidence_url: "https://acme.com/team/jane-doe",
			evidence_quote: "Jane Doe is Acme's VP of Sales.",
			evidence_kind: "first_party" as const,
			confidence: 0.9,
		};

		globalThis.fetch = async () =>
			contentsResponse(verdict.evidence_url, {
				text: "Nothing about Jane Doe here.",
			});
		expect(
			await quoteOnPage(
				verdict.evidence_url,
				verdict.evidence_quote,
				exaEnv(),
				new CostLedger(),
			),
		).toEqual({ found: false, reason: "missing" });

		globalThis.fetch = async () =>
			contentsResponse(verdict.evidence_url, { errorTag: "CRAWL_NOT_FOUND" });
		expect(
			await quoteOnPage(
				verdict.evidence_url,
				verdict.evidence_quote,
				exaEnv(),
				new CostLedger(),
			),
		).toEqual({ found: false, reason: "CRAWL_NOT_FOUND" });

		globalThis.fetch = async () =>
			contentsResponse(verdict.evidence_url, {
				errorTag: "SOURCE_NOT_AVAILABLE",
			});
		expect(
			await quoteOnPage(
				verdict.evidence_url,
				verdict.evidence_quote,
				exaEnv(),
				new CostLedger(),
			),
		).toEqual({ found: false, reason: "SOURCE_NOT_AVAILABLE" });

		expect(classifyVerdict(verdict)).toBe("verified");
	});
});

describe("verify: the quote guard's contents call", () => {
	it("raises RetryableProviderError on a 429 and banks cost on success", async () => {
		globalThis.fetch = async () =>
			jsonResponse(429, { requestId: "req-429", message: "slow down" });
		await expect(
			quoteOnPage(
				"https://acme.com/team/jane-doe",
				"Jane Doe",
				exaEnv(),
				new CostLedger(),
			),
		).rejects.toThrow(RetryableProviderError);

		globalThis.fetch = async () =>
			contentsResponse("https://acme.com/team/jane-doe", {
				text: "Jane Doe is Acme's VP of Sales.",
			});
		const ledger = new CostLedger();
		await quoteOnPage(
			"https://acme.com/team/jane-doe",
			"Jane Doe",
			exaEnv(),
			ledger,
		);
		expect(ledger.total()).toBeCloseTo(0.003, 5);
	});

	it("raises NonRetryableError on a malformed body", async () => {
		globalThis.fetch = async () =>
			jsonResponse(200, { requestId: "req-bad", results: "not-an-array" });
		await expect(
			quoteOnPage(
				"https://acme.com/team/jane-doe",
				"Jane Doe",
				exaEnv(),
				new CostLedger(),
			),
		).rejects.toThrow(NonRetryableError);
	});
});
