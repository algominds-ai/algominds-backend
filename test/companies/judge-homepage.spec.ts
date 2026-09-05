import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CompanyRow } from "@/core/companies/gate";
import type { RequirementEvidence } from "@/core/companies/judge";
import { judge } from "@/core/companies/judge";
import type { Requirement } from "@/core/requirements";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse, fakeGateway } from "../support/fetch";

const requirements: Requirement[] = [
	{
		id: "r1",
		text: "the company is a seed stage fintech in San Francisco with a small team",
		kind: "hard",
		proof: "record",
		windowDays: null,
	},
];

const rows: CompanyRow[] = [
	{
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		evidenceUrl: null,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: "Acme sells a platform for banks",
		signal: null,
		evidenceDate: null,
	},
];

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function bodyOf(
	call: { body: unknown } | undefined,
): z.infer<typeof RequestBodySchema> {
	if (!call) throw new Error("expected a captured request");
	return RequestBodySchema.parse(call.body);
}

function userMessage(call: { body: unknown } | undefined): string {
	return bodyOf(call)
		.messages.map((message) => message.content)
		.join("\n");
}

function verdictsFor(rowSet: readonly CompanyRow[]) {
	return {
		verdicts: rowSet.map((_row, index) => ({
			index,
			statuses: [{ id: "r1", status: "proven" }],
			reason: "fits the profile",
			sameOrganizationAs: null,
		})),
	};
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("the judge reads a row's own homepage next to its record", () => {
	it("carries the homepage text and labels it, when the round found one", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: JSON.stringify(verdictsFor(rows)) }),
		]);
		globalThis.fetch = gateway.fetch;
		const evidenceByRow = new Map<number, Map<string, RequirementEvidence>>([
			[
				0,
				new Map([
					[
						"homepage",
						{
							url: "https://acme.com/",
							quote: "An important update for Acme customers",
						},
					],
				]),
			],
		]);

		await judge(requirements, rows, fakeGatewayEnv(), evidenceByRow);

		const sent = userMessage(gateway.calls[0]);
		expect(sent).toContain("homepage");
		expect(sent).toContain("An important update for Acme customers");
	});
});
