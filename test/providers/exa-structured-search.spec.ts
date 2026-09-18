import { afterEach, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import { search } from "@/core/providers/exa/search";
import { fakeSecretEnv } from "../support/env";
import { jsonResponse, respondOnce } from "../support/fetch";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const output = {
	content: { role: "Founder" },
	grounding: [
		{
			field: "role",
			citations: [{ url: "https://example.com/team", title: "Team" }],
			confidence: "high",
		},
	],
};

it("preserves requested structured output, native citations and returned highlights", async () => {
	const captured = respondOnce(
		jsonResponse({
			requestId: "structured",
			costDollars: { total: 0.012 },
			results: [
				{
					url: "https://example.com/team",
					title: "Team",
					highlights: ["Alex, Founder"],
				},
			],
			output,
		}),
	);
	globalThis.fetch = captured.fetch;
	const outputSchema = {
		type: "object",
		properties: { role: { type: "string" } },
		required: ["role"],
	};
	const result = await search(
		{
			query: "Alex",
			type: "deep",
			category: "people",
			outputSchema,
			contents: { highlights: true, maxAgeHours: 0 },
		},
		fakeSecretEnv({ EXA_API_KEY: "test" }),
		new CostLedger(),
	);
	expect(JSON.parse(String(captured.calls[0]?.init?.body))).toMatchObject({
		outputSchema,
		contents: { highlights: true, maxAgeHours: 0 },
	});
	expect(result.output).toEqual(output);
	expect(result.results[0]?.highlights).toEqual(["Alex, Founder"]);
});

it("retains the reported charge when paid output cannot be parsed", async () => {
	globalThis.fetch = respondOnce(
		jsonResponse({
			requestId: "malformed-paid",
			costDollars: { total: 0.012 },
			results: "invalid",
		}),
	).fetch;
	const ledger = new CostLedger();
	await expect(
		search({ query: "Alex" }, fakeSecretEnv({ EXA_API_KEY: "test" }), ledger),
	).rejects.toThrow("malformed-paid");
	expect(ledger.total()).toBe(0.012);
});
