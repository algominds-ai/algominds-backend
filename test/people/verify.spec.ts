import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import {
	classifyVerdict,
	employerOpinion,
	indexOpinion,
} from "@/core/people/verify";
import { getAgentVerdictRun } from "@/core/providers/exa/agent";
import { quoteOnPage } from "@/core/providers/exa/contents";
import { RetryableProviderError } from "@/core/providers/waterfall";
import verdictRun from "../fixtures/exa-agent-run-verdict.json";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";
import {
	chatCompletionResponse,
	exaContentsFetch,
	jsonResponse,
} from "../support/fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

function personSearchResponse(): Response {
	return jsonResponse({
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
		globalThis.fetch = exaContentsFetch({
			"https://acme.com/team/jane-doe": {
				text: "Leadership. Jane Doe is Acme's VP of Sales. Contact the team.",
			},
		});
		const agentRunFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) =>
			String(input).includes("/agent/runs/")
				? jsonResponse(verdictRun)
				: agentRunFetch(input, init);

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

async function employerLabelFor(
	employer: string,
	reply: "UNKNOWN" | "SAME",
): Promise<string> {
	globalThis.fetch = async () =>
		chatCompletionResponse({ content: JSON.stringify({ employer: reply }) });
	const opinion = await employerOpinion(
		{ employer, company: "Acme Inc", domain: "acme.com" },
		fakeModelEnv(),
		new CostLedger(),
	);
	return opinion.label;
}

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

		expect(await employerLabelFor(index.employer ?? "", "UNKNOWN")).toBe(
			"UNKNOWN",
		);
		expect(await employerLabelFor(index.employer ?? "", "SAME")).toBe("SAME");
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
		globalThis.fetch = exaContentsFetch({
			"https://seccl.tech/blog/meet-the-secclers": {
				text: "This week, we're welcoming\nKristina Harris, our new growth director.",
			},
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
		globalThis.fetch = exaContentsFetch({
			"https://acme.com/team/jane-doe": {
				text: "Nothing about Jane Doe here.",
			},
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
		const url = "https://acme.com/team/jane-doe";
		const quote = "Jane Doe is Acme's VP of Sales.";

		globalThis.fetch = exaContentsFetch({ [url]: { text: "Nothing here." } });
		expect(await quoteOnPage(url, quote, exaEnv(), new CostLedger())).toEqual({
			found: false,
			reason: "missing",
		});

		globalThis.fetch = exaContentsFetch({
			[url]: { errorTag: "CRAWL_NOT_FOUND" },
		});
		expect(await quoteOnPage(url, quote, exaEnv(), new CostLedger())).toEqual({
			found: false,
			reason: "CRAWL_NOT_FOUND",
		});

		expect(
			classifyVerdict({
				verdict: "CONFIRMED",
				evidence_url: url,
				evidence_quote: quote,
				evidence_kind: "first_party",
				confidence: 0.9,
			}),
		).toBe("verified");
	});
});

describe("verify: the quote guard's contents call", () => {
	it("raises RetryableProviderError on a 429 and banks cost on success", async () => {
		globalThis.fetch = async () => jsonResponse({ requestId: "req-429" }, 429);
		await expect(
			quoteOnPage(
				"https://acme.com/team/jane-doe",
				"Jane Doe",
				exaEnv(),
				new CostLedger(),
			),
		).rejects.toThrow(RetryableProviderError);

		globalThis.fetch = exaContentsFetch({
			"https://acme.com/team/jane-doe": {
				text: "Jane Doe is Acme's VP of Sales.",
			},
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
			jsonResponse({ requestId: "req-bad", results: "not-an-array" });
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
