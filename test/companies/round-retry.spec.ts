import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import type { Requirement } from "@/core/requirements";
import type { SynthesizeInput } from "@/core/synthesize";
import { roundDeps } from "@/workflows/find-companies-agent";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse } from "../support/fetch";
import { fakeRetryingWorkflowStep } from "../support/step";

const requirements: Requirement[] = [
	{
		id: "r1",
		text: "the company is a seed stage fintech in San Francisco",
		kind: "hard",
		proof: "record",
		windowDays: null,
	},
];

function row(name: string, domain: string): CompanyRow {
	return {
		name,
		domain,
		linkedinUrl: null,
		evidenceUrl: `https://${domain}/careers`,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: "hiring a founding engineer",
		evidenceDate: "2026-08-20",
	};
}

const rows: CompanyRow[] = [row("Acme", "acme.com")];

function synthesizeInput(): SynthesizeInput {
	return {
		icp: { description: "seed stage fintech companies in San Francisco" },
		requirements,
		pastAngles: [],
		feedback: [],
		today: "2026-09-05",
		angles: 1,
		provenRate: null,
	};
}

function planReply(): { content: string } {
	return {
		content: JSON.stringify({
			route: "search",
			rounds: [{ angle: "seed fintech in SF", query: "seed fintech in SF" }],
			userLocation: "US",
			countries: ["United States"],
			minWorkforce: null,
			maxWorkforce: 20,
			minFoundedYear: null,
			maxFoundedYear: null,
			minRevenueAnnual: null,
			maxRevenueAnnual: null,
			minFundingTotal: null,
			maxFundingTotal: null,
		}),
	};
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("a round whose judge gives up never re-runs the round's own synthesize", () => {
	it("calls the round's synthesize step exactly once, even though the judge fails every attempt", async () => {
		let call = 0;
		globalThis.fetch = async () => {
			call += 1;
			if (call === 1) return chatCompletionResponse(planReply());
			throw new DOMException("The operation timed out.", "TimeoutError");
		};

		const { step, calls } = fakeRetryingWorkflowStep();
		const round = 1;
		const deps = roundDeps({
			accumulatedDomains: new Set(),
			runId: "companies_round-retry",
			step,
			round,
			today: "2026-09-05",
			seller: null,
			timings: [],
		});
		const env = fakeGatewayEnv();

		const runRound = () =>
			step.do(`round_${round}`, config.stepConfig.roundCall, async () => {
				const synthesized = await deps.synthesize(synthesizeInput(), env);
				await deps.judge(requirements, rows, env);
				return { route: synthesized.route };
			});

		await expect(runRound()).rejects.toThrow();

		expect(
			calls.filter((name) => name === `round_${round}-synthesize`),
		).toHaveLength(1);
	});
});
