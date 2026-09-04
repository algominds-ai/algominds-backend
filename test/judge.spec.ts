import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { config } from "../src/config";
import type { CompanyRow } from "../src/core/companies/gate";
import { judge } from "../src/core/companies/judge";
import type { Requirement } from "../src/core/requirements";

const env: Env = {
	...testEnv,
	AI_GATEWAY_BASE_URL: "https://gateway.test.example/compat",
	CF_AIG_TOKEN: { get: async () => "test-aig-token" },
	MODEL_ROUTE_REASONING: "dynamic/brain-reasoning",
	MODEL_ROUTE_WORKER: "dynamic/brain-worker",
};

const requirements: Requirement[] = [
	{
		id: "r1",
		text: "the company is a seed stage fintech in San Francisco with a small team",
		kind: "hard",
		proof: "record",
		windowDays: null,
	},
	{
		id: "r2",
		text: "the company posted a founding engineer role in the last thirty days",
		kind: "soft",
		proof: "page",
		windowDays: 30,
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

type ScriptedVerdict = {
	index: number;
	statuses: Array<{ id: string; status: string }>;
	soft: string[];
	reason: string;
	sameOrganizationAs: number | null;
};

function verdictsFor(rowSet: readonly CompanyRow[]): {
	verdicts: ScriptedVerdict[];
} {
	return {
		verdicts: rowSet.map((_, index) => {
			const keep = index !== 1;
			return {
				index,
				statuses: [{ id: "r1", status: keep ? "proven" : "contradicted" }],
				soft: [],
				reason: keep ? "fits the profile" : "no qualifying signal",
				sameOrganizationAs: null,
			};
		}),
	};
}

/** Whether a scripted verdict left every hard requirement satisfied, the shape the round's own decision reads. */
function kept(verdict: {
	statuses: ReadonlyArray<{ status: string }>;
}): boolean {
	return verdict.statuses.every((entry) => entry.status === "proven");
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

		await judge(requirements, rows, env);

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

		await judge(requirements, rows, env);

		expect(modelInBody(gateway.calls[0])).toBe(env.MODEL_ROUTE_REASONING);
	});

	it("sends cf-aig-cache-ttl and never cf-aig-skip-cache", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, env);

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

		const result = await judge(requirements, rows, env);

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

		const result = await judge(requirements, rows, env);

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

		const result = await judge(requirements, rows, env);

		expect(result.verdicts).toHaveLength(rows.length);
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
		});
		expect(kept(result.verdicts[1] ?? { statuses: [] })).toBe(false);
	});

	it("carries a kept row's reason through to the caller, not just a refused row's", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(
				objectReply({
					verdicts: rows.map((_, index) => ({
						index,
						statuses: [{ id: "r1", status: "proven" }],
						soft: [],
						reason: "fits the profile",
						sameOrganizationAs: null,
					})),
				}),
			),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, env);

		expect(result.verdicts.every(kept)).toBe(true);
		expect(
			result.verdicts.every((verdict) => verdict.reason === "fits the profile"),
		).toBe(true);
	});

	it("carries a refused row's reason through to the caller", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, env);

		expect(result.verdicts[1]?.reason).toBe("no qualifying signal");
	});

	it("retries once after a schema failure and returns the retry's result", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, env);

		expect(gateway.calls).toHaveLength(2);
		expect(result.verdicts).toHaveLength(rows.length);
	});

	it("falls back to every hard requirement unproven after two consecutive failures, without throwing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, env);

		expect(gateway.calls).toHaveLength(2);
		expect(result.verdicts).toHaveLength(rows.length);
		expect(result.verdicts.every(kept)).toBe(false);
		for (const verdict of result.verdicts) {
			expect(verdict.statuses).toEqual([{ id: "r1", status: "unproven" }]);
		}
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
		});
	});
});

describe("the judge is told which requirements need a status", () => {
	function userMessage(call: { body: unknown }): string {
		const parsed = z
			.object({ messages: z.array(z.object({ content: z.string() })) })
			.parse(call.body);
		return parsed.messages.map((message) => message.content).join("\n");
	}

	it("asks for a status on every hard requirement, by its id", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, env);

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("Requirements needing a status:");
		expect(sent).toContain("r1 the company is a seed stage fintech");
	});

	it("lists the soft requirements apart, asking for no status on them", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, env);

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("Preferences.");
		expect(sent).toContain("r2 the company posted a founding engineer role");
		expect(sent).toContain("give no status for these");
	});

	it("says nothing about preferences when the profile asks for none", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const hardOnly = requirements.filter((req) => req.kind === "hard");
		await judge(hardOnly, rows, env);

		expect(userMessage({ body: gateway.calls[0]?.body })).not.toContain(
			"Preferences.",
		);
	});

	it("names the three statuses it accepts and asks for the same-organisation label", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, env);

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("proven");
		expect(sent).toContain("contradicted");
		expect(sent).toContain("unproven");
		expect(sent).toContain("sameOrganizationAs");
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

		await judge(requirements, labelled, env);

		const sent = userMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("acme.com");
		expect(sent).toContain("hiring a founding engineer");
		expect(sent).not.toContain("evidenceKind");
		expect(sent).not.toContain("vendor-case-study");
	});
});

type DeferredCall = { url: string; headers: Headers; body: unknown };

function deferredGateway(): {
	fetch: typeof fetch;
	calls: DeferredCall[];
	resolvers: Array<(response: Response) => void>;
} {
	const calls: DeferredCall[] = [];
	const resolvers: Array<(response: Response) => void> = [];
	const handler: typeof fetch = (input, init) => {
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body,
		});
		return new Promise<Response>((resolve) => {
			resolvers.push(resolve);
		});
	};
	return { fetch: handler, calls, resolvers };
}

async function flushMicrotasks(iterations = 200): Promise<void> {
	for (let i = 0; i < iterations; i++) await Promise.resolve();
}

function rowCountIn(call: DeferredCall | undefined): number {
	const sent = z
		.object({ messages: z.array(z.object({ content: z.string() })) })
		.parse(call?.body)
		.messages.map((message) => message.content)
		.join("\n");
	return (sent.match(/^\d+: /gm) ?? []).length;
}

describe("judge: slicing a large batch into concurrent, ordered calls", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends 35 rows as three concurrent calls of 15, 15 and 5, and returns every index in row order however the calls resolve", async () => {
		const bigRows: CompanyRow[] = Array.from({ length: 35 }, (_, i) =>
			row(`Company ${i}`, `co${i}.com`),
		);
		const gateway = deferredGateway();
		globalThis.fetch = gateway.fetch;

		const pending = judge(requirements, bigRows, env);

		await flushMicrotasks();
		expect(gateway.calls).toHaveLength(3);
		const sizes = gateway.calls.map((call) => rowCountIn(call));
		expect(sizes).toEqual([15, 15, 5]);
		expect(config.companies.judgeBatchSize).toBe(15);

		for (const callIndex of [2, 0, 1]) {
			const size = sizes[callIndex] ?? 0;
			const verdicts = Array.from({ length: size }, (_, i) => ({
				index: i,
				statuses: [{ id: "r1", status: "proven" }],
				soft: [],
				reason: "fits the profile",
				sameOrganizationAs: null,
			}));
			gateway.resolvers[callIndex]?.(
				chatCompletionResponse(objectReply({ verdicts })),
			);
		}

		const result = await pending;

		expect(result.verdicts).toHaveLength(35);
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
			expect(kept(verdict)).toBe(true);
		});
	});
});

describe("a requirement the row says nothing about is unproven, never a guess", () => {
	function everyMessage(call: { body: unknown }): string {
		const parsed = z
			.object({ messages: z.array(z.object({ content: z.string() })) })
			.parse(call.body);
		return parsed.messages.map((message) => message.content).join("\n");
	}

	it("tells the judge to leave a silent requirement unproven rather than guess it", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, env);

		const sent = everyMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("says nothing about is `unproven`");
		expect(sent).toContain("guess one either way");
	});

	it("tells the judge a quote about another company proves nothing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, env);

		const sent = everyMessage({ body: gateway.calls[0]?.body });
		expect(sent).toContain("a quote about another company");
	});
});
