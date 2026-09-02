import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "../src/core/cost";
import {
	classifyVerdict,
	employerOpinion,
	indexOpinion,
	quoteOnPage,
} from "../src/core/people/verify";
import { getAgentVerdictRun } from "../src/core/providers/exa/agent";
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
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url.includes("/agent/runs/")) return jsonResponse(200, verdictRun);
			return new Response(
				"Leadership. Jane Doe is Acme's VP of Sales. Contact the team.",
				{ status: 200 },
			);
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

describe("verify: the quote guard refuses unsafe URLs", () => {
	it("reports unsafe-url for a non-https or credentialed URL", async () => {
		expect(
			await quoteOnPage("http://acme.com/team", "Jane Doe", exaEnv()),
		).toEqual({ found: false, reason: "unsafe-url" });

		expect(
			await quoteOnPage(
				"https://user:pass@acme.com/team",
				"Jane Doe",
				exaEnv(),
			),
		).toEqual({ found: false, reason: "unsafe-url" });
	});
});

describe("verify: the quote guard normalises markup before matching", () => {
	it("matches a quote through curly punctuation, entities, and an inline tag", async () => {
		globalThis.fetch = async () =>
			new Response(
				"<p>This week, we’re welcoming <a></a>Kristina&nbsp;Harris, our new growth director.</p>",
				{ status: 200, headers: { "content-type": "text/html" } },
			);
		expect(
			await quoteOnPage(
				"https://seccl.tech/blog/meet-the-secclers",
				"This week, we're welcoming Kristina Harris, our new growth director.",
				exaEnv(),
			),
		).toEqual({ found: true, reason: "found" });
	});

	it("still reports missing when the quote genuinely is not on the page", async () => {
		globalThis.fetch = async () =>
			new Response("Nothing about Jane Doe here.", { status: 200 });
		expect(
			await quoteOnPage(
				"https://acme.com/team/jane-doe",
				"Jane Doe is Acme's VP of Sales.",
				exaEnv(),
			),
		).toEqual({ found: false, reason: "missing" });
	});
});

describe("verify: the quote guard drops the URL rather than the verdict", () => {
	it("keeps a verdict but drops an unsupported URL", async () => {
		const verdict = {
			verdict: "CONFIRMED" as const,
			evidence_url: "https://acme.com/team/jane-doe",
			evidence_quote: "Jane Doe is Acme's VP of Sales.",
			evidence_kind: "first_party" as const,
			confidence: 0.9,
		};

		globalThis.fetch = async () =>
			new Response("Nothing about Jane Doe here.", { status: 200 });
		expect(
			await quoteOnPage(verdict.evidence_url, verdict.evidence_quote, exaEnv()),
		).toEqual({ found: false, reason: "missing" });

		globalThis.fetch = async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		};
		expect(
			await quoteOnPage(verdict.evidence_url, verdict.evidence_quote, exaEnv()),
		).toEqual({ found: false, reason: "timeout" });

		globalThis.fetch = async () => new Response("gone", { status: 404 });
		expect(
			await quoteOnPage(verdict.evidence_url, verdict.evidence_quote, exaEnv()),
		).toEqual({ found: false, reason: "fetch:404" });

		expect(classifyVerdict(verdict)).toBe("verified");
	});
});
