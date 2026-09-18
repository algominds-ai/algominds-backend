import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it } from "vitest";
import { CostLedger } from "../../src/core/cost";
import { getAgentRun } from "../../src/core/providers/exa/agent";
import { exaContents } from "../../src/core/providers/exa/contents";
import { pollAgentRun } from "../../src/workflows/agent-poll";
import sourceCheck from "../fixtures/company/agent-source.json";
import emptyRun from "../fixtures/exa-agent-run-empty.json";
import runningRun from "../fixtures/exa-agent-run-running.json";
import shortArticle from "../fixtures/exa-contents-short-article.json";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, respondOnce } from "../support/fetch";
import { fakeWorkflowStep } from "../support/step";

function exaEnv(): Env {
	return fakeSecretEnv({ EXA_API_KEY: "test-exa-key" });
}

type CompletedRunOverrides = {
	output?: {
		structured: { companies: Array<{ name?: string; website?: string }> };
	};
};

function completedRunBody(overrides: CompletedRunOverrides = {}) {
	return {
		id: "run-completed",
		status: "completed",
		output: {
			structured: {
				companies: [{ name: "Acme", website: "acme.com", evidence: [] }],
			},
		},
		costDollars: { total: 0.025, agentCompute: 0.018, search: 0.007 },
		...overrides,
	};
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("agent run response shape", () => {
	it("raises NonRetryableError, not a half-parsed object, on a malformed completed body", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({
				status: "completed",
				output: { structured: { companies: "not-an-array" } },
				costDollars: { total: 0.01 },
			}),
		).fetch;

		let caught: unknown;
		try {
			await getAgentRun("run-bad", exaEnv(), new CostLedger());
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NonRetryableError);
	});

	it("records a completed run fee before rejecting malformed structured output", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({
				status: "completed",
				output: { structured: { companies: "not-an-array" } },
				costDollars: { total: 0.01 },
			}),
		).fetch;
		const ledger = new CostLedger();

		await expect(
			getAgentRun("run-bad", exaEnv(), ledger),
		).rejects.toBeInstanceOf(NonRetryableError);
		expect(ledger.total()).toBeCloseTo(0.01, 5);
	});

	it("treats a run still running as running, not completed", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({ id: "run-running", status: "running" }),
		).fetch;

		const run = await getAgentRun("run-running", exaEnv(), new CostLedger());

		expect(run.status).toBe("running");
	});

	it("reads a null structured payload as running, not as a bad shape", async () => {
		globalThis.fetch = async () => jsonResponse(runningRun);

		const run = await getAgentRun(runningRun.id, exaEnv(), new CostLedger());

		expect(run.status).toBe("running");
	});

	it("surfaces a failed or canceled run as an error rather than empty success", async () => {
		const failedLedger = new CostLedger();
		globalThis.fetch = respondOnce(
			jsonResponse({
				id: "run-failed",
				status: "failed",
				costDollars: { total: 0.004 },
			}),
		).fetch;
		await expect(
			getAgentRun("run-failed", exaEnv(), failedLedger),
		).rejects.toThrow(NonRetryableError);
		expect(failedLedger.total()).toBeCloseTo(0.004, 5);

		globalThis.fetch = respondOnce(
			jsonResponse({ id: "run-canceled", status: "canceled" }),
		).fetch;
		await expect(
			getAgentRun("run-canceled", exaEnv(), new CostLedger()),
		).rejects.toThrow(/canceled/);
	});
});

describe("pollAgentRun preserves a terminal parser failure's fee", () => {
	it("returns the failed step as durable data before throwing", async () => {
		globalThis.fetch = respondOnce(
			jsonResponse({
				status: "completed",
				output: { structured: { companies: "not-an-array" } },
				costDollars: { total: 0.01 },
			}),
		).fetch;
		const { step } = fakeWorkflowStep();
		const ledger = new CostLedger();

		await expect(
			pollAgentRun(
				{
					env: exaEnv(),
					step,
					name: "agent-probe",
					id: "run-bad",
					intervalSeconds: 1,
					maxAttempts: 1,
				},
				ledger,
				async (pollLedger) => {
					const run = await getAgentRun("run-bad", exaEnv(), pollLedger);
					return run.status === "completed"
						? { status: "completed" as const, output: run.companies }
						: run;
				},
			),
		).rejects.toThrow(NonRetryableError);
		expect(ledger.total()).toBeCloseTo(0.01, 5);
	});
});

describe("agent run cost reporting", () => {
	it("keeps decisive facts omitted from highlights when the full article fits", async () => {
		const article = shortArticle.results[0];
		if (!article) throw new Error("missing captured article");
		globalThis.fetch = respondOnce(jsonResponse(shortArticle)).fetch;
		const result = await exaContents(
			[article.url],
			exaEnv(),
			new CostLedger(),
			{
				query: "recent market entry or funding and revenue",
				maxCharacters: 10_000,
			},
		);
		expect(article.highlights.join(" ")).not.toContain("$200M");
		expect(result.results[0]?.text).toBe(article.text);
		expect(result.results[0]?.text).toContain("surpassed $200M annual revenue");
	});

	it("uses native literal highlights when the source passage is beyond the prefix", async () => {
		const response = structuredClone(sourceCheck.response);
		const invalid = respondOnce(
			jsonResponse({
				...response,
				results: response.results.map((result) => ({
					...result,
					highlights: ["fabricated text that is not on the page"],
				})),
			}),
		);
		globalThis.fetch = invalid.fetch;
		const options = { query: sourceCheck.request.highlights.query };
		const fallback = await exaContents(
			sourceCheck.request.urls,
			exaEnv(),
			new CostLedger(),
			options,
		);
		const request = JSON.parse(String(invalid.calls[0]?.init?.body));
		expect(request.text).toBe(true);
		expect(request.highlights.query).toBe(options.query);
		expect(fallback.results[0]?.text).not.toContain("fabricated text");
		globalThis.fetch = respondOnce(jsonResponse(response)).fetch;
		const selected = await exaContents(
			sourceCheck.request.urls,
			exaEnv(),
			new CostLedger(),
			options,
		);
		expect(selected.results[0]?.text).toContain("verify your age prior");
	});

	it("reports costDollars into the ledger once the run completes", async () => {
		globalThis.fetch = respondOnce(jsonResponse(completedRunBody())).fetch;
		const ledger = new CostLedger();

		await getAgentRun("run-completed", exaEnv(), ledger);

		const byProvider = ledger.byProvider();
		expect(byProvider.agentCompute).toBe(0.018);
		expect(byProvider.search).toBe(0.007);
		expect(ledger.total()).toBeCloseTo(0.025, 5);
	});

	it("spends nothing from the ledger while a run is still working", async () => {
		globalThis.fetch = async () => jsonResponse(runningRun);
		const ledger = new CostLedger();

		await getAgentRun(runningRun.id, exaEnv(), ledger);

		expect(ledger.total()).toBe(0);
	});
});

describe("a completed agent run that reports no companies is an empty result, not a bad shape", () => {
	it("parses companies: null into an empty array, still banking the run's cost", async () => {
		globalThis.fetch = respondOnce(jsonResponse(emptyRun)).fetch;
		const ledger = new CostLedger();

		const run = await getAgentRun(emptyRun.id, exaEnv(), ledger);

		expect(run.status).toBe("completed");
		if (run.status !== "completed") return;
		expect(run.companies).toEqual([]);
		expect(ledger.total()).toBeCloseTo(0.012, 5);
	});
});
