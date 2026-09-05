import { describe, expect, it, vi } from "vitest";
import {
	CostLedger,
	isGatewayCacheHit,
	recordModelCall,
	resolveModelId,
} from "@/core/cost";

function headersWith(entries: Record<string, string>): Headers {
	return new Headers(entries);
}

describe("resolveModelId", () => {
	it("prices the header's model over the response id, over the configured id, warning only when both are absent", () => {
		const warnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		const fromHeader = resolveModelId(
			headersWith({ "cf-aig-model": "openai/gpt-4.1-mini" }),
			"anthropic/claude-sonnet-4.5",
			"anthropic/claude-sonnet-4.5",
		);
		const fromResponse = resolveModelId(
			headersWith({}),
			"openai/gpt-4.1-mini",
			"anthropic/claude-sonnet-4.5",
		);
		const fromConfig = resolveModelId(
			headersWith({}),
			undefined,
			"anthropic/claude-sonnet-4.5",
		);

		expect(fromHeader).toBe("openai/gpt-4.1-mini");
		expect(fromResponse).toBe("openai/gpt-4.1-mini");
		expect(fromConfig).toBe("anthropic/claude-sonnet-4.5");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});
});

describe("isGatewayCacheHit", () => {
	it("recognizes an HIT status and treats MISS or an absent header as a miss", () => {
		expect(
			isGatewayCacheHit(headersWith({ "cf-aig-cache-status": "HIT" })),
		).toBe(true);
		expect(
			isGatewayCacheHit(headersWith({ "cf-aig-cache-status": "MISS" })),
		).toBe(false);
		expect(isGatewayCacheHit(headersWith({}))).toBe(false);
	});
});

describe("recordModelCall", () => {
	it("records zero on a gateway cache hit, even though the gateway reports a cost", () => {
		const ledger = new CostLedger();

		recordModelCall(ledger, "synthesize", "dynamic/reasoning", {
			headers: new Headers({ "cf-aig-cache-status": "HIT" }),
			usage: { cost: 1.78e-6 },
		});

		expect(ledger.total()).toBe(0);
	});

	it("reports the gateway's own dollar cost under the model it actually used", () => {
		const ledger = new CostLedger();

		recordModelCall(ledger, "synthesize", "dynamic/reasoning", {
			headers: new Headers({
				"cf-aig-cache-status": "MISS",
				"cf-aig-model": "deepseek/deepseek-v4-flash-0731",
			}),
			usage: { cost: 1.78e-6 },
		});

		expect(ledger.byProvider()["deepseek/deepseek-v4-flash-0731"]).toBeCloseTo(
			1.78e-6,
			12,
		);
	});
});
