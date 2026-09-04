import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Candidate } from "../src/core/people/candidate";
import { selectBuyers } from "../src/core/people/select";

const env: Env = {
	...testEnv,
	AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
	CF_AIG_TOKEN: { get: async () => "test-aig-token" },
	MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
	MODEL_ROUTE_WORKER: "dynamic/brain-worker",
};

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

type CapturedRequest = { url: string; headers: Headers; body: unknown };

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function messagesFor(request: CapturedRequest | undefined) {
	if (!request) throw new Error("expected a captured request");
	return RequestBodySchema.parse(request.body).messages;
}

type ScriptedReply = {
	content: string;
	finishReason?: "stop" | "length";
	cost?: number;
};

function chatCompletionResponse(reply: ScriptedReply): Response {
	const model = "deepseek/deepseek-v4-flash-0731";
	const payload = {
		id: "chatcmpl-test",
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: reply.content },
				finish_reason: reply.finishReason ?? "stop",
			},
		],
		usage: {
			prompt_tokens: 30,
			completion_tokens: 12,
			cost: reply.cost ?? 0.00002,
		},
	};
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"cf-aig-model": model,
			"cf-aig-provider": "openrouter",
			"cf-aig-cache-status": "MISS",
		},
	});
}

function fakeGateway(responses: readonly Response[]): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
} {
	const calls: CapturedRequest[] = [];
	let index = 0;
	const handler: typeof fetch = async (input, init) => {
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body,
		});
		const response = responses[index];
		index += 1;
		if (!response)
			throw new Error(`fakeGateway: no scripted response for call ${index}`);
		return response;
	};
	return { fetch: handler, calls };
}

function objectReply(value: unknown, cost?: number): ScriptedReply {
	return cost === undefined
		? { content: JSON.stringify(value) }
		: { content: JSON.stringify(value), cost };
}

describe("selectBuyers: returns observed candidates by id", () => {
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
		const gateway = fakeGateway([chatCompletionResponse(objectReply(reply))]);
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
			},
			env,
		);

		expect(result.picks).toHaveLength(2);
		expect(result.picks[0]?.candidate).toEqual(candidates[0]);
		expect(result.picks[0]?.basis).toBe("explicit_persona_match");
		expect(result.picks[1]?.candidate).toEqual(candidates[1]);
		expect(result.picks[1]?.basis).toBe("inferred_workflow_owner");
		expect(result.picks[0]?.candidate.title).toBe("Chief Financial Officer");
		expect(result.picks[0]?.candidate.url).toBe(
			"https://linkedin.com/in/person-1",
		);
		expect(result.droppedIds).toEqual([]);
		expect(result.reply).toEqual(reply);
	});
});

describe("selectBuyers: drops only invented picks", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps every known pick, however many the rubric matches, and drops only unknown ids", async () => {
		const candidates = Array.from({ length: 7 }, (_, index) =>
			candidate(index + 1, `Title ${index + 1}`),
		);
		const reply = {
			picks: [
				{ id: 1, basis: "explicit_persona_match" },
				{ id: 2, basis: "explicit_persona_match" },
				{ id: 3, basis: "explicit_persona_match" },
				{ id: 4, basis: "explicit_persona_match" },
				{ id: 5, basis: "explicit_persona_match" },
				{ id: 6, basis: "explicit_persona_match" },
				{ id: 7, basis: "explicit_persona_match" },
				{ id: 999, basis: "inferred_workflow_owner" },
			],
		};
		const gateway = fakeGateway([chatCompletionResponse(objectReply(reply))]);
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
			},
			env,
		);

		expect(result.picks).toHaveLength(7);
		expect(result.picks.map((pick) => pick.candidate.id)).toEqual([
			1, 2, 3, 4, 5, 6, 7,
		]);
		expect(result.droppedIds).toEqual([999]);
	});
});

describe("selectBuyers: treats an empty model reply as no buyers", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns zero picks, a null reply, and the ledger's cost after two failures", async () => {
		const candidates = [candidate(1, "Chief Financial Officer")];
		const gateway = fakeGateway([
			chatCompletionResponse({
				content: "",
				finishReason: "length",
				cost: 0.00001,
			}),
			chatCompletionResponse({
				content: "",
				finishReason: "length",
				cost: 0.00001,
			}),
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
			},
			env,
		);

		expect(gateway.calls).toHaveLength(2);
		expect(result.picks).toEqual([]);
		expect(result.droppedIds).toEqual([]);
		expect(result.reply).toBeNull();
		expect(result.costDollars).toBeCloseTo(0.00002, 12);
	});
});

describe("selectBuyers: never places roster or rubric text inside the instructions", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends the rubric and roster as delimited data, not as instructions", async () => {
		const sentinelTitle = "Zorblatt Quantum Efficiency Officer";
		const sentinelRubric =
			"Only the person who personally owns the annual budget for quantum widgets qualifies.";
		const candidates = [candidate(1, sentinelTitle)];
		const reply = { picks: [] };
		const gateway = fakeGateway([chatCompletionResponse(objectReply(reply))]);
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
	});
});
