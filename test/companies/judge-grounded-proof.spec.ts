import { afterEach, describe, expect, it } from "vitest";
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

function row(description: string): CompanyRow {
	return {
		name: "Acme",
		domain: "acme.com",
		linkedinUrl: null,
		evidenceUrl: null,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description,
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
			[row("Acme lets consumers sign up for the app themselves")],
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
			[row("Acme distributes its lending platform through bank partners")],
			fakeGatewayEnv(),
		);

		expect(result.verdicts[0]?.statuses[0]?.status).toBe("unproven");
	});

	it("leaves a non-strict, non-page requirement's proven status untouched with no quote", async () => {
		const gateway = fakeGateway([
			verdictReply([{ id: "r2", status: "proven" }]),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(
			[plainRequirement],
			[row("Acme is a seed stage fintech in San Francisco")],
			fakeGatewayEnv(),
		);

		expect(result.verdicts[0]?.statuses).toEqual([
			{ id: "r2", status: "proven" },
		]);
	});
});
