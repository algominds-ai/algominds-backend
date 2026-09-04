import { vi } from "vitest";
import { z } from "zod";

export type Handler = (init: RequestInit | undefined) => Response;

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A `fetch` routed by request pathname alone, for a single vendor host. Unhandled paths 404. */
export function fakeFindymail(handlers: Record<string, Handler>): typeof fetch {
	return async (input, init) => {
		const pathname = new URL(String(input)).pathname;
		const handler = handlers[pathname];
		return handler ? handler(init) : new Response(null, { status: 404 });
	};
}

/** A `fetch` routed to the Exa table for `api.exa.ai`, and the other table for every other host. */
export function fakeVendors(
	findymail: Record<string, Handler>,
	exa: Record<string, Handler>,
): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		const table = url.hostname === "api.exa.ai" ? exa : findymail;
		const handler = table[url.pathname];
		return handler ? handler(init) : new Response(null, { status: 404 });
	};
}

export type CapturedFetch = { url: string; headers: Headers; body: unknown };

/** An Exa `/search` success reply carrying one result per page, costed at a flat total. */
export function exaSearchResultsResponse(
	pages: readonly { url: string; text: string }[],
): Response {
	return jsonResponse({
		requestId: "req-search",
		costDollars: { total: 0.01 },
		results: pages.map((page) => ({
			url: page.url,
			title: page.url,
			text: page.text,
		})),
	});
}

/** A `fetch` that answers Exa calls and model-gateway calls from two separate scripted queues, recording both. */
export function fakeExaAndModel(
	exa: readonly Response[],
	model: readonly Response[],
): {
	fetch: typeof fetch;
	exaCalls: CapturedFetch[];
	modelCalls: CapturedFetch[];
} {
	const exaCalls: CapturedFetch[] = [];
	const modelCalls: CapturedFetch[] = [];
	let exaIndex = 0;
	let modelIndex = 0;
	const handler: typeof fetch = async (input, init) => {
		const url = String(input);
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const captured: CapturedFetch = {
			url,
			headers: new Headers(init?.headers),
			body,
		};
		if (url.includes("api.exa.ai")) {
			const response = exa[exaIndex];
			exaIndex += 1;
			exaCalls.push(captured);
			if (!response)
				throw new Error("fakeExaAndModel: no scripted exa response left");
			return response;
		}
		const response = model[modelIndex];
		modelIndex += 1;
		modelCalls.push(captured);
		if (!response)
			throw new Error("fakeExaAndModel: no scripted model response left");
		return response;
	};
	return { fetch: handler, exaCalls, modelCalls };
}

export function requestedEmail(init: RequestInit | undefined): string {
	const body: { email?: string } = JSON.parse(String(init?.body ?? "{}"));
	return body.email ?? "";
}

const ContentsRequestSchema = z.object({ urls: z.array(z.string()) });

type ContentsOutcome =
	| { text: string }
	| { errorTag: string }
	| { absent: true };

type ContentsStatus =
	| { id: string; status: "success" }
	| { id: string; status: "error"; error: { tag: string } };

type ContentsEntry = {
	status: ContentsStatus | null;
	result: { url: string; text: string } | null;
};

/** One url's contribution to the `/contents` reply: null status and result when it is `absent`, an error status when the crawl failed, else a success status and its text. */
function contentsEntry(url: string, outcome: ContentsOutcome): ContentsEntry {
	if ("absent" in outcome) return { status: null, result: null };
	if ("errorTag" in outcome) {
		return {
			status: { id: url, status: "error", error: { tag: outcome.errorTag } },
			result: null,
		};
	}
	return {
		status: { id: url, status: "success" },
		result: { url, text: outcome.text },
	};
}

function resolveContentsOutcome(
	byUrl: Record<string, ContentsOutcome>,
	url: string,
): ContentsOutcome {
	const outcome = byUrl[url];
	if (!outcome) throw new Error(`unexpected contents request for ${url}`);
	return outcome;
}

/** The Exa `/contents` endpoint, answering only the urls named in `byUrl`; an `absent` entry is requested but left out of the reply entirely, and any url missing from `byUrl` throws. */
export function exaContentsFetch(
	byUrl: Record<string, ContentsOutcome>,
): typeof fetch {
	return async (_input, init) => {
		const { urls } = ContentsRequestSchema.parse(
			JSON.parse(String(init?.body)),
		);
		const entries = urls.map((url) =>
			contentsEntry(url, resolveContentsOutcome(byUrl, url)),
		);
		return jsonResponse({
			requestId: "req-contents",
			results: entries.flatMap((entry) => entry.result ?? []),
			statuses: entries.flatMap((entry) => entry.status ?? []),
			costDollars: { total: 0.003 },
		});
	};
}

export type ExaAgentRunScript = {
	completeAfterPolls?: number;
	structured: unknown;
	costDollars?: { total: number; agentCompute?: number };
};

/** An Exa agent-run `fetch`: a POST starts a run and is recorded, a GET polls it, completing after `completeAfterPolls` polls (default one) with `structured` as its output. */
export function fakeExaAgentRun(script: ExaAgentRunScript): {
	fetch: typeof fetch;
	started: { body: unknown }[];
} {
	const started: { body: unknown }[] = [];
	const pollCounts = new Map<string, number>();
	const completeAfter = script.completeAfterPolls ?? 1;
	let nextId = 0;
	const handler: typeof fetch = async (input, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			started.push({ body });
			const id = `run-${nextId}`;
			nextId += 1;
			pollCounts.set(id, 0);
			return jsonResponse({ id, status: "running" });
		}
		const id = String(input).split("/").pop() ?? "";
		const count = (pollCounts.get(id) ?? 0) + 1;
		pollCounts.set(id, count);
		if (count < completeAfter) return jsonResponse({ id, status: "running" });
		return jsonResponse({
			id,
			object: "agent_run",
			status: "completed",
			stopReason: "schema_satisfied",
			output: { text: "done", structured: script.structured },
			costDollars: script.costDollars ?? { total: 0.01, agentCompute: 0.01 },
		});
	};
	return { fetch: handler, started };
}

/** A completed Exa agent run polling the person the enrich waterfall expects, overridable per field. */
export function completedAgentRun(overrides: { output?: unknown } = {}) {
	return {
		id: "agent-run-1",
		status: "completed",
		output: {
			structured: {
				fullName: "Kirk Marple",
				title: "Founder and Chief Executive Officer",
				email: "kirk@graphlit.com",
				linkedinUrl: "https://www.linkedin.com/in/kirkmarple",
				source: "https://www.linkedin.com/posts/kirkmarple_hiring",
			},
		},
		costDollars: { total: 0.025, agentCompute: 0.02, search: 0.005 },
		...overrides,
	};
}

const CLAY_HEADERS = { "content-type": "application/json" };

export function clayResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: CLAY_HEADERS,
	});
}

export type ClayRosterRow = {
	name: string;
	url: string;
	title: string;
	company: string;
};

/** Stubs `globalThis.fetch` as Clay's filters-mode search followed by its roster read, answering with `rows`. */
export function stubClayFetch(rows: ClayRosterRow[]): void {
	let call = 0;
	globalThis.fetch = async (input) => {
		call += 1;
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			return clayResponse({ search_id: `search-${call}` });
		}
		return clayResponse({
			data: rows.map((row) => ({
				name: row.name,
				url: row.url,
				latest_experience_title: row.title,
				latest_experience_company: row.company,
				latest_experience_start_date: null,
				location: null,
			})),
			has_more: false,
			period_quota: { used: rows.length },
		});
	};
}

/** Stubs `globalThis.fetch` as a Clay search that starts, then rejects every run with a 400. */
export function stubClayRejectFetch(): { runCalls: number } {
	const calls = { runCalls: 0 };
	globalThis.fetch = async (input) => {
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			return clayResponse({ search_id: "search-rejected" });
		}
		calls.runCalls += 1;
		return new Response(
			JSON.stringify({ error: "invalid company_identifier" }),
			{ status: 400, headers: CLAY_HEADERS },
		);
	};
	return calls;
}

export type ClayCreateFilters = {
	company_identifier: string[];
	job_title_seniority_levels_v2?: string[];
	job_title_keywords?: string[];
};

function clayCreateFilters(init: RequestInit | undefined): ClayCreateFilters {
	const body: { filters?: ClayCreateFilters } = JSON.parse(
		String(init?.body ?? "{}"),
	);
	if (!body.filters)
		throw new Error("expected a Clay create body with filters");
	return body.filters;
}

/** Stubs `globalThis.fetch` as Clay's create-then-run search, recording every create call's filters and answering every run with an empty page. */
export function stubClayCreateCapture(): {
	creates: ClayCreateFilters[];
	runCalls: number;
} {
	const creates: ClayCreateFilters[] = [];
	const state = { creates, runCalls: 0 };
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			state.creates.push(clayCreateFilters(init));
			return clayResponse({ search_id: `search-${state.creates.length}` });
		}
		state.runCalls += 1;
		return clayResponse({ data: [], has_more: false });
	};
	return state;
}

export type CapturedRequest = { url: string; headers: Headers; body: unknown };

export type ScriptedReply = {
	content: string;
	finishReason?: "stop" | "length";
	cost?: number | null;
	model?: string;
	cacheStatus?: "HIT" | "MISS";
};

/** The AI Gateway's OpenAI-compatible chat-completion reply, carrying the scripted content and cost. A `cost` of `null` omits `usage.cost` entirely, for the reply shape a real gateway response sometimes carries. */
export function chatCompletionResponse(reply: ScriptedReply): Response {
	const model = reply.model ?? "deepseek/deepseek-v4-flash-0731";
	const cost = reply.cost === undefined ? 0.000003 : reply.cost;
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
			...(cost === null ? {} : { cost }),
		},
	};
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"cf-aig-model": model,
			"cf-aig-provider": "openrouter",
			"cf-aig-cache-status": reply.cacheStatus ?? "MISS",
		},
	});
}

/** A `fetch` that answers the AI Gateway with each scripted response in turn, recording every request made. */
export function fakeGateway(responses: readonly Response[]): {
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

export type CapturedCall = { url: string; init: RequestInit | undefined };

/** A `fetch` that always answers `response`, recording every call's url and init. */
export function respondOnce(response: Response): {
	fetch: typeof fetch;
	calls: CapturedCall[];
} {
	const calls: CapturedCall[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			calls.push({ url: String(input), init });
			return response;
		},
	};
}

/** A `fetch` that answers each call with the next scripted response, repeating the last once exhausted. */
export function respondInSequence(responses: readonly Response[]): {
	fetch: typeof fetch;
	calls: CapturedCall[];
} {
	const calls: CapturedCall[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			calls.push({ url: String(input), init });
			const response =
				responses[calls.length - 1] ?? responses[responses.length - 1];
			if (!response) throw new Error("respondInSequence: no response scripted");
			return response;
		},
	};
}

/** A `fetch` that throws the transport timeout every direct vendor call maps to `RetryableProviderError` on. */
export function throwsTimeout(): typeof fetch {
	return async () => {
		throw new DOMException("The operation timed out.", "TimeoutError");
	};
}

/** Stubs `setTimeout` to run its callback immediately, recording every requested wait in milliseconds. */
export function stubSleep(): { waits: number[] } {
	const waits: number[] = [];
	vi.stubGlobal("setTimeout", (callback: () => void, ms: number) => {
		waits.push(ms);
		callback();
		return 0;
	});
	return { waits };
}

export type ClaySequenceStep = { response: Response } | { throwTimeout: true };

export type ClaySequenceCalls = {
	calls: number;
	runCalls: number;
	inits: (RequestInit | undefined)[];
	creates: ClayCreateFilters[];
};

function isClayCreateCall(input: unknown): boolean {
	return new URL(String(input)).pathname === "/public/v0/search/filters-mode";
}

/** Stubs `globalThis.fetch` as one Clay create-then-run sequence, counting only the run calls and recording every init. */
export function stubClaySequence(
	input: readonly (ClaySequenceStep | Response)[],
): ClaySequenceCalls {
	const steps: ClaySequenceStep[] = input.map((entry) =>
		entry instanceof Response ? { response: entry } : entry,
	);
	const calls: ClaySequenceCalls = {
		calls: 0,
		runCalls: 0,
		inits: [],
		creates: [],
	};
	let step = 0;
	globalThis.fetch = async (input, init) => {
		calls.calls += 1;
		calls.inits.push(init);
		if (isClayCreateCall(input)) calls.creates.push(clayCreateFilters(init));
		const current = steps[step] ?? steps[steps.length - 1];
		step += 1;
		if (!isClayCreateCall(input)) calls.runCalls += 1;
		if (!current) return new Response(null, { status: 404 });
		if ("throwTimeout" in current) {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}
		return current.response;
	};
	return calls;
}

type JsonRpcId = string | number | null;
type JsonRpcRequestBody = { id?: JsonRpcId; method?: string };

function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"mcp-session-id": "test-session",
		},
	});
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
		{
			status: 200,
			headers: {
				"content-type": "application/json",
				"mcp-session-id": "test-session",
			},
		},
	);
}

export type FakeMcpServerOptions = {
	toolName: string;
	failToolCall?: boolean;
	capturedHeaders: Headers[];
	deletes: { count: number };
};

function respondToMcpRpc(
	body: JsonRpcRequestBody,
	opts: FakeMcpServerOptions,
): Response {
	const id = body.id ?? null;
	switch (body.method) {
		case "server/discover":
			return jsonRpcError(id, -32601, "Method not found");
		case "initialize":
			return jsonRpcResult(id, {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-mcp", version: "1.0.0" },
			});
		case "notifications/initialized":
			return new Response(null, { status: 202 });
		case "tools/list":
			return jsonRpcResult(id, {
				tools: [
					{
						name: opts.toolName,
						inputSchema: { type: "object", properties: {} },
					},
				],
			});
		case "tools/call":
			if (opts.failToolCall) return jsonRpcError(id, -32000, "tool boom");
			return jsonRpcResult(id, { content: [{ type: "text", text: "ok" }] });
		default:
			return new Response(null, { status: 404 });
	}
}

/** An MCP JSON-RPC server over HTTP: `initialize`, `tools/list` and `tools/call` for one named tool, and a `DELETE` session close it counts. */
export function fakeMcpServer(opts: FakeMcpServerOptions): typeof fetch {
	return async (_input, init) => {
		const method = init?.method ?? "GET";
		if (method === "GET") return new Response(null, { status: 405 });
		if (method === "DELETE") {
			opts.deletes.count += 1;
			return new Response(null, { status: 200 });
		}
		opts.capturedHeaders.push(new Headers(init?.headers));
		const body: JsonRpcRequestBody = JSON.parse(String(init?.body ?? "{}"));
		return respondToMcpRpc(body, opts);
	};
}

/** An AI Gateway `fetch` that records every request but never resolves on its own, so a test can flush pending calls before choosing the order each one completes in. */
export function deferredGateway(): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
	resolvers: Array<(response: Response) => void>;
} {
	const calls: CapturedRequest[] = [];
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
