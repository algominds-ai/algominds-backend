import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import type { SynthesizeInput } from "@/core/synthesize";
import { roundDeps } from "@/workflows/find-companies-agent";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse } from "../support/fetch";
import { profileFixture, requirementFixture } from "../support/icp";
import { fakeRetryingWorkflowStep } from "../support/step";

const requirements = [
	requirementFixture("the company is a seed stage fintech in San Francisco"),
];

function row(name: string, domain: string): CompanyRow {
	return {
		name,
		domain,
		linkedinUrl: null,
		record: null,
		description: null,
	};
}

const rows: CompanyRow[] = [row("Acme", "acme.com")];

function synthesizeInput(): SynthesizeInput {
	return {
		icp: profileFixture({}, "seed stage fintech companies in San Francisco"),
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
	it("allows the observed 331-second agent run and time to judge its results", () => {
		const pollSeconds =
			config.companies.exaAgentMaxPollAttempts *
			config.companies.exaAgentPollIntervalSeconds;
		const [amount, unit] = config.stepConfig.roundCall.timeout.split(" ");
		expect(unit).toBe("minutes");
		expect(pollSeconds).toBeGreaterThan(331);
		expect(Number(amount) * 60).toBeGreaterThan(pollSeconds + 180);
	});

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
			remaining: 15,
			runId: "companies_round-retry",
			step,
			round,
			today: "2026-09-05",
			icp: profileFixture(),
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
			calls.filter((name) => name.startsWith(`round_${round}-synthesize`)),
		).toHaveLength(1);
	});
});
