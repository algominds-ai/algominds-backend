import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CompanyRow } from "@/core/companies/gate";
import { judge } from "@/core/companies/judge";
import type { Requirement } from "@/core/requirements";
import { fakeGatewayEnv } from "../support/env";
import { chatCompletionResponse, fakeGateway } from "../support/fetch";

const strictRequirement: Requirement = {
	id: "r1",
	text: "the company sells direct to consumers who self-serve their own signup",
	kind: "hard",
	proof: "record",
	windowDays: null,
	strict: true,
};

const plainRequirement: Requirement = {
	id: "r2",
	text: "the company is a seed stage fintech in San Francisco",
	kind: "hard",
	proof: "record",
	windowDays: null,
};

function row(overrides: {
	description?: string | null;
	evidenceQuote?: string | null;
}): CompanyRow {
	return {
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		evidenceUrl: null,
		evidenceQuote: overrides.evidenceQuote ?? null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: overrides.description ?? null,
		signal: null,
		evidenceDate: null,
	};
}

type JudgedStatus = { id: string; status: string; quote?: string };

function verdictReply(statuses: JudgedStatus[]) {
	return chatCompletionResponse({
		content: JSON.stringify({
			verdicts: [
				{
					index: 0,
					statuses,
					reason: "",
					sameOrganizationAs: null,
				},
			],
		}),
	});
}

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function userMessage(call: { body: unknown } | undefined): string {
	if (!call) throw new Error("expected a captured request");
	return RequestBodySchema.parse(call.body)
		.messages.map((message) => message.content)
		.join("\n");
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("a strict requirement is proven only by a quoted passage from the row's own evidence", () => {
	it("stays proven when the quote occurs verbatim in the row's evidence text", async () => {
		const gateway = fakeGateway([
			verdictReply([
				{
					id: "r1",
					status: "proven",
					quote: "consumers sign up for the app themselves",
				},
			]),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(
			[strictRequirement],
			[
				row({
					description: "Acme lets consumers sign up for the app themselves",
				}),
			],
			fakeGatewayEnv(),
		);

		expect(result.verdicts[0]?.statuses).toEqual([
			{
				id: "r1",
				status: "proven",
				quote: "consumers sign up for the app themselves",
			},
		]);
	});

	it("downgrades to unproven when the quote does not occur in the row's evidence text", async () => {
		const gateway = fakeGateway([
			verdictReply([
				{
					id: "r1",
					status: "proven",
					quote: "consumers sign up for the app themselves",
				},
			]),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(
			[strictRequirement],
			[
				row({
					description:
						"Acme distributes its lending platform through bank partners",
				}),
			],
			fakeGatewayEnv(),
		);

		expect(result.verdicts[0]?.statuses[0]?.status).toBe("unproven");
	});

	it("leaves a non-strict, non-page requirement's proven status untouched with an empty quote", async () => {
		const gateway = fakeGateway([
			verdictReply([{ id: "r2", status: "proven", quote: "" }]),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(
			[plainRequirement],
			[row({ description: "Acme is a seed stage fintech in San Francisco" })],
			fakeGatewayEnv(),
		);

		expect(result.verdicts[0]?.statuses).toEqual([
			{ id: "r2", status: "proven", quote: "" },
		]);
	});
});

describe("the prompt marks which requirements need a quote", () => {
	it("marks a strict requirement's line and leaves a plain one unmarked", async () => {
		const gateway = fakeGateway([
			verdictReply([
				{ id: "r1", status: "proven", quote: "consumers sign up" },
				{ id: "r2", status: "proven", quote: "" },
			]),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(
			[strictRequirement, plainRequirement],
			[row({ description: "Acme lets consumers sign up" })],
			fakeGatewayEnv(),
		);

		const sent = userMessage(gateway.calls[0]);
		expect(sent).toContain(
			"r1 the company sells direct to consumers who self-serve their own signup (quote required)",
		);
		expect(sent).toContain(
			"r2 the company is a seed stage fintech in San Francisco",
		);
		expect(sent).not.toContain(
			"r2 the company is a seed stage fintech in San Francisco (quote required)",
		);
	});
});

describe("a quote must occur inside one evidence passage, not across two", () => {
	it("stays proven when the quote occurs inside a single passage", async () => {
		const gateway = fakeGateway([
			verdictReply([
				{
					id: "r1",
					status: "proven",
					quote: "consumers sign up for the app themselves",
				},
			]),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(
			[strictRequirement],
			[
				row({
					description: "Acme lets consumers sign up for the app themselves",
					evidenceQuote: "bank partners resell the platform",
				}),
			],
			fakeGatewayEnv(),
		);

		expect(result.verdicts[0]?.statuses[0]?.status).toBe("proven");
	});

	it("downgrades to unproven when the quote is only assembled by joining two passages", async () => {
		const gateway = fakeGateway([
			verdictReply([
				{
					id: "r1",
					status: "proven",
					quote: "consumers sign up for the app themselves",
				},
			]),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(
			[strictRequirement],
			[
				row({
					description: "Acme lets consumers sign up",
					evidenceQuote: "for the app themselves",
				}),
			],
			fakeGatewayEnv(),
		);

		expect(result.verdicts[0]?.statuses[0]?.status).toBe("unproven");
	});
});
