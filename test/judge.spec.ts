import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CompanyRow } from "../src/core/companies/gate";
import { judge } from "../src/core/companies/judge";
import type { IcpDoc } from "../src/core/synthesize";

const env: Env = {
	...testEnv,
	AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
	CF_AIG_TOKEN: { get: async () => "test-aig-token" },
	MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
	MODEL_ROUTE_WORKER: "dynamic/brain-worker",
};

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

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

const rows: CompanyRow[] = [
	row("Acme", "acme.com"),
	row("Zenith", "zenith.com"),
	row("Sable", "sable.com"),
];

type CapturedRequest = { url: string; headers: Headers; body: unknown };

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function modelInBody(request: CapturedRequest | undefined): string {
	if (!request) throw new Error("expected a captured request");
	return RequestBodySchema.parse(request.body).model;
}

type ScriptedReply = {
	content: string;
	finishReason?: "stop" | "length";
	cost?: number;
	model?: string;
};

function chatCompletionResponse(reply: ScriptedReply): Response {
	const model = reply.model ?? "deepseek/deepseek-v4-flash-0731";
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
			cost: reply.cost ?? 0.000003,
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

function verdictsFor(rowSet: readonly CompanyRow[]): {
	verdicts: Array<{ index: number; keep: boolean; reason: string | null }>;
} {
	return {
		verdicts: rowSet.map((_, index) => {
			const keep = index !== 1;
			return {
				index,
				keep,
				reason: keep ? null : "no qualifying signal",
			};
		}),
	};
}

describe("judge: gateway wiring", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends cf-aig-authorization and targets a URL under /compat", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, null);

		const call = gateway.calls[0];
		expect(call?.headers.get("cf-aig-authorization")).toBe(
			"Bearer test-aig-token",
		);
		expect(new URL(String(call?.url)).pathname).toContain("/compat");
	});

	it("selects MODEL_ROUTE_REASONING in the request body", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, null);

		expect(modelInBody(gateway.calls[0])).toBe(env.MODEL_ROUTE_REASONING);
	});

	it("sends cf-aig-cache-ttl and never cf-aig-skip-cache", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, null);

		expect(gateway.calls).toHaveLength(2);
		for (const call of gateway.calls) {
			expect(call.headers.get("cf-aig-cache-ttl")).toBeTruthy();
			expect(call.headers.has("cf-aig-skip-cache")).toBe(false);
		}
	});

	it("reports the gateway's returned cost on the ledger", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows), 0.0000091)),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(icp, rows, env, null);

		expect(result.ledger.total()).toBeCloseTo(0.0000091, 12);
	});
});

describe("judge: cost recording without a cost field", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("records zero, not NaN or undefined, when the response body carries no usage.cost", async () => {
		const payload = {
			id: "chatcmpl-test",
			model: "deepseek/deepseek-v4-flash-0731",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: JSON.stringify(verdictsFor(rows)),
					},
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 30, completion_tokens: 12 },
		};
		const response = new Response(JSON.stringify(payload), {
			status: 200,
			headers: {
				"content-type": "application/json",
				"cf-aig-model": "deepseek/deepseek-v4-flash-0731",
				"cf-aig-cache-status": "MISS",
			},
		});
		const gateway = fakeGateway([response]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(icp, rows, env, null);

		expect(result.ledger.total()).toBe(0);
	});
});

describe("judge: verdicts and retries", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns one verdict per input row, indices matching input order", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(icp, rows, env, null);

		expect(result.verdicts).toHaveLength(rows.length);
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
		});
		expect(result.verdicts[1]?.keep).toBe(false);
	});

	it("parses a kept row whose reason is null", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({
					verdicts: rows.map((_, index) => ({
						index,
						keep: true,
						reason: null,
					})),
				}),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(icp, rows, env, null);

		expect(result.verdicts.every((verdict) => verdict.keep)).toBe(true);
		expect(result.verdicts.every((verdict) => verdict.reason === null)).toBe(
			true,
		);
	});

	it("carries a refused row's reason through to the caller", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(icp, rows, env, null);

		expect(result.verdicts[1]?.reason).toBe("no qualifying signal");
	});

	it("retries once after a schema failure and returns the retry's result", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(icp, rows, env, null);

		expect(gateway.calls).toHaveLength(2);
		expect(result.verdicts).toHaveLength(rows.length);
	});

	it("falls back to keeping every gated row after two consecutive failures, without throwing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(icp, rows, env, null);

		expect(gateway.calls).toHaveLength(2);
		expect(result.verdicts).toHaveLength(rows.length);
		expect(result.verdicts.every((verdict) => verdict.keep)).toBe(true);
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
		});
	});
});

describe("the judge is told the window it must hold rows to", () => {
	function userMessage(call: { body: unknown }): string {
		const parsed = z
			.object({ messages: z.array(z.object({ content: z.string() })) })
			.parse(call.body);
		return parsed.messages.map((message) => message.content).join("\n");
	}

	it("carries the freshness window when the profile asked for one", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, "A role posted in the last 30 days.");

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("Freshness window:");
		expect(sent).toContain("A role posted in the last 30 days.");
	});

	it("says nothing about a window when the profile asked for none", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, null);

		expect(userMessage({ body: gateway.calls[0]?.body })).not.toContain(
			"Freshness window:",
		);
	});

	it("tells the judge that an undated page can still prove a live signal", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, "A role posted in the last 30 days.");

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("job advertisement still open");
		expect(sent).toContain("proves nothing without a date");
	});

	it("tells the judge to weigh the page, not only the profile", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, null);

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("evidenceQuote");
		expect(sent).toContain("names no publisher");
	});
});

describe("the kind of page a row came from is a label, not something the judge weighs", () => {
	function userMessage(call: { body: unknown }): string {
		const parsed = z
			.object({ messages: z.array(z.object({ content: z.string() })) })
			.parse(call.body);
		return parsed.messages.map((message) => message.content).join("\n");
	}

	it("serialises every other field of the row and leaves the kind out", async () => {
		const labelled: CompanyRow[] = [
			{ ...row("Acme", "acme.com"), evidenceKind: "vendor-case-study" },
		];
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(labelled))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, labelled, env, null);

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("acme.com");
		expect(sent).toContain("hiring a founding engineer");
		expect(sent).not.toContain("evidenceKind");
		expect(sent).not.toContain("vendor-case-study");
	});
});

describe("a row from a source that produces no quote is judged on the record", () => {
	function everyMessage(call: { body: unknown }): string {
		const parsed = z
			.object({ messages: z.array(z.object({ content: z.string() })) })
			.parse(call.body);
		return parsed.messages.map((message) => message.content).join("\n");
	}

	it("never refuses a row merely for carrying no quote and no publisher", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(icp, rows, env, null);

		const sent = everyMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("never refuse it for their absence");
		expect(sent).not.toContain(
			"Every row carries the page its signal came from",
		);
	});
});
