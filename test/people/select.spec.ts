import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import type { Candidate } from "@/core/people/candidate";
import { selectBuyers } from "@/core/people/select";
import { fakeModelEnv } from "../support/env";
import type { CapturedRequest } from "../support/fetch";
import { chatCompletionResponse, fakeGateway } from "../support/fetch";

const env = fakeModelEnv();
const rubric = "The head of finance or the founder who owns the budget.";

function candidate(id: number, title: string | null): Candidate {
	return {
		id,
		name: `Person ${id}`,
		title,
		company: "Acme",
		url: `https://linkedin.com/in/person-${id}`,
		location: null,
		since: null,
		seenBy: ["clay"],
	};
}

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function messagesFor(request: CapturedRequest | undefined) {
	if (!request) throw new Error("expected a captured request");
	return RequestBodySchema.parse(request.body).messages;
}

function objectReply(value: unknown) {
	return { content: JSON.stringify(value) };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

it("returns observed candidates by id", async () => {
	const candidates = [
		candidate(1, "Chief Financial Officer"),
		candidate(2, "Founder"),
		candidate(3, "Director of Sales"),
	];
	const reply = {
		picks: [
			{ id: 1, basis: "explicit_persona_match" },
			{ id: 2, basis: "inferred_workflow_owner" },
		],
	};
	globalThis.fetch = fakeGateway([
		chatCompletionResponse(objectReply(reply)),
	]).fetch;

	const result = await selectBuyers(
		{
			description: null,
			buyer: {
				mode: "profile",
				buyerSource: "captured",
				rubric,
				bands: ["c-suite"],
				keywordBands: [],
			},
			candidates,
			company: { name: "Acme", workforceTotal: null },
		},
		env,
	);

	expect(result.picks).toHaveLength(2);
	expect(result.picks[0]?.candidate).toEqual(candidates[0]);
	expect(result.picks[0]?.basis).toBe("explicit_persona_match");
	expect(result.picks[1]?.candidate).toEqual(candidates[1]);
	expect(result.droppedIds).toEqual([]);
	expect(result.reply).toEqual(reply);
});

it("keeps every known pick, however many the rubric matches, and drops only unknown ids", async () => {
	const candidates = Array.from({ length: 7 }, (_, index) =>
		candidate(index + 1, `Title ${index + 1}`),
	);
	const reply = {
		picks: [
			...candidates.map((c) => ({ id: c.id, basis: "explicit_persona_match" })),
			{ id: 999, basis: "inferred_workflow_owner" },
		],
	};
	globalThis.fetch = fakeGateway([
		chatCompletionResponse(objectReply(reply)),
	]).fetch;

	const result = await selectBuyers(
		{
			description: null,
			buyer: {
				mode: "profile",
				buyerSource: "captured",
				rubric,
				bands: ["c-suite"],
				keywordBands: [],
			},
			candidates,
			company: { name: "Acme", workforceTotal: null },
		},
		env,
	);

	expect(result.picks.map((pick) => pick.candidate.id)).toEqual([
		1, 2, 3, 4, 5, 6, 7,
	]);
	expect(result.droppedIds).toEqual([999]);
});

it("returns zero picks, a null reply, and the ledger's cost after two failures", async () => {
	const candidates = [candidate(1, "Chief Financial Officer")];
	const emptyReply = {
		content: "",
		finishReason: "length" as const,
		cost: 0.00001,
	};
	const gateway = fakeGateway([
		chatCompletionResponse(emptyReply),
		chatCompletionResponse(emptyReply),
	]);
	globalThis.fetch = gateway.fetch;

	const result = await selectBuyers(
		{
			description: null,
			buyer: {
				mode: "profile",
				buyerSource: "captured",
				rubric,
				bands: ["c-suite"],
				keywordBands: [],
			},
			candidates,
			company: { name: "Acme", workforceTotal: null },
		},
		env,
	);

	expect(gateway.calls).toHaveLength(2);
	expect(result.picks).toEqual([]);
	expect(result.reply).toBeNull();
	expect(result.costDollars).toBeCloseTo(0.00002, 12);
});

it("sends the rubric and roster as delimited data, not as instructions", async () => {
	const sentinelTitle = "Zorblatt Quantum Efficiency Officer";
	const sentinelRubric =
		"Only the person who personally owns the annual budget for quantum widgets qualifies.";
	const candidates = [candidate(1, sentinelTitle)];
	const gateway = fakeGateway([
		chatCompletionResponse(objectReply({ picks: [] })),
	]);
	globalThis.fetch = gateway.fetch;

	await selectBuyers(
		{
			description: "quantum widget sellers to fintech buyers",
			buyer: {
				mode: "profile",
				buyerSource: "captured",
				rubric: sentinelRubric,
				bands: ["c-suite"],
				keywordBands: [],
			},
			candidates,
			company: { name: "Acme", workforceTotal: null },
		},
		env,
	);

	const messages = messagesFor(gateway.calls[0]);
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n");
	const user = messages
		.filter((message) => message.role !== "system")
		.map((message) => message.content)
		.join("\n");

	expect(system).not.toContain(sentinelTitle);
	expect(system).not.toContain(sentinelRubric);
	expect(user).toContain(sentinelTitle);
	expect(user).toContain(sentinelRubric);
	expect(system).toContain("exclude a candidate whose");
	expect(user).toContain("| (no location)");
});

it("sends the company's headcount in the prompt data when the caller knows it", async () => {
	const candidates = [candidate(1, "Founder")];
	const gateway = fakeGateway([
		chatCompletionResponse(objectReply({ picks: [] })),
	]);
	globalThis.fetch = gateway.fetch;

	await selectBuyers(
		{
			description: null,
			buyer: {
				mode: "profile",
				buyerSource: "captured",
				rubric,
				bands: ["c-suite"],
				keywordBands: [],
			},
			candidates,
			company: { name: "Acme", workforceTotal: 42 },
		},
		env,
	);

	const user = messagesFor(gateway.calls[0])
		.filter((message) => message.role !== "system")
		.map((message) => message.content)
		.join("\n");
	expect(user).toContain("company: Acme, 42 employees");
});

it("tells the model the company's headcount is unknown rather than guessing a number", async () => {
	const candidates = [candidate(1, "Founder")];
	const gateway = fakeGateway([
		chatCompletionResponse(objectReply({ picks: [] })),
	]);
	globalThis.fetch = gateway.fetch;

	await selectBuyers(
		{
			description: null,
			buyer: {
				mode: "profile",
				buyerSource: "captured",
				rubric,
				bands: ["c-suite"],
				keywordBands: [],
			},
			candidates,
			company: { name: "Acme", workforceTotal: null },
		},
		env,
	);

	const user = messagesFor(gateway.calls[0])
		.filter((message) => message.role !== "system")
		.map((message) => message.content)
		.join("\n");
	expect(user).toContain("company: Acme, headcount unknown");
});
